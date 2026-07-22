# 📄 Hypersign KYC ID Widget Integration Guide

This document is a comprehensive integration guide for developers embedding the pre-built **Hypersign KYC ID Widget** into their web applications. By utilizing the pre-built widget, you can deploy a secure, compliant, and conversion-optimized identity verification flow with minimal development effort, while leaving the heavy lifting of biometric processing and decentralized identity (DID) registration to Hypersign's backend.

---

## 1. Integration Architecture

The integration follows a **Security-First Delegated Handshake** model:

* **Backend Application:** Securely manages your administrative `API_SECRET` keys, handles short-lived orchestration tokens, maps user profiles to Decentralized Identifiers (DIDs), and manages session instantiation.
* **Hypersign ID Widget:** A pre-built, optimized UI overlay hosted by Hypersign that seamlessly manages user-facing permissions, camera captures, automated OCR extraction, liveness detection, and zero-knowledge signature generation.
* **Frontend Application:** Initializes the client-side session handshake, embeds the Hypersign ID Widget popup container, and listens for real-time interface messaging events (such as session termination or validation errors) to seamlessly update your app's user interface.

```

+--------------------------------------------------+          +------------------+          +--------------------------------+
|                  Client Browser                  |          |  Your Backend    |          | Hypersign  Verification Service|
+--------------------------------------------------+          +------------------+          +--------------------------------+
|  Host Application   |    Hypersign ID Widget     |          |                  |          |                                |
+---------------------+----------------------------+          +------------------+          +--------------------------------+
           |                        |                           |                                       |
           | -- [1. Fetch Session & Session JWTs] ------------->|                                       |
           |                        |                           | -- [2. Authenticate & Create DID] --->|
           |                        |                           | <-- [3. Return App/User Tokens] ------|
           | <– [4. Mount Widget with Secure Tokens] -----------|                                       |
           |                        |                                                                   |
           |                        | ---- [5. Orchestrate Captures, Biometrics & ZK Proofs] ---------->|
           |                        |                                                                   |
           |                        |                           |<-- [6. Fire Webhook (Done)] ----------|
```
 
---

## 2. Base Configuration

### Service URLs
Initialize the base endpoints for the Hypersign and credential routing services:


- KYC_BASE_URL: [https://api.cavach.hypersign.id](https://api.cavach.hypersign.id);
- SSI_BASE_URL: [https://api.entity.hypersign.id](https://api.entity.hypersign.id);
- DEVELOPER_DASHBOARD_SERVICE_BASE_URL: [https://api.entity.dashboard.hypersign.id](https://api.entity.dashboard.hypersign.id);

### Prerequisite Setup

1. **Dashboard Access:** Create your developer account inside the [Hypersign Dashboard](https://entity.dashboard.hypersign.id/).
2. **Environment Secrets:** Securely generate and download your `SSI_API_SECRET` and `KYC_API_SECRET` keys from the App Settings view. Store these in your backend `.env` configuration file.
3. **Issuer Information:** Copy your application's unique decentralized identifier configuration from the SSI sub-portal:

```javascript
const X_ISSUER_DID = "did:hid:z6MkmEFC8N1AUsinEBNSszXoepHb45p38ZwidV58r1HPqCkU";
const X_ISSUER_VERMETHOD_ID = "did:hid:z6MkmEFC8N1AUsinEBNSszXoepHb45p38ZwidV58r1HPqCkU#key-1"; 
```
> Note: Please make sure that `X_ISSUER_VERMETHOD_ID` is of type `Ed25519VerificationKey2020`

You can keep these variables in your `.env`

```
KYC_BASE_URL=
SSI_BASE_URL=
DEVELOPER_DASHBOARD_SERVICE_BASE_URL=
X_ISSUER_DID=
X_ISSUER_VERMETHOD_ID=
SSI_API_SECRET=
KYC_API_SECRET=
```

---

## 3. Backend Implementation (Node.js)

The backend acts as an authenticated proxy layer. Under no circumstances should administrative API secrets be exposed to client-side code.

### STEP 1: Prepare Administrative Access Tokens

Administrative Bearer tokens for KYC and SSI services must be cached locally and refreshed automatically only upon token expiration.

```javascript
// In-memory token cache store sample
const tokenStoreCache = {};

async function fetchAdminAccessToken(apiSecret, serviceType) {
    const cachedToken = tokenStoreCache[serviceType];

    // Check if valid token exists and hasn't expired
    if (cachedToken && cachedToken.expiryTime > Date.now()) {
        return cachedToken.access_token;
    }

    const url = `${DEVELOPER_DASHBOARD_SERVICE_BASE_URL}/api/v1/app/oauth?grant_type=${serviceType}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'X-Api-Secret-Key': apiSecret,
            'Accept': 'application/json'
        }
    });

    const result = await response.json();
    if (!response.ok) throw new Error(`Auth failed: ${result.message}`);
    
    const { access_token, expiresIn } = result;
    
    // Buffer expiration by 10 seconds to account for network latency
    const expiryTime = Date.now() + (expiresIn * 1000) - 10000;
  
    tokenStoreCache[serviceType] = {
        access_token,
        expiryTime
    };

    return access_token;
}

```

### STEP 2: Register or Fetch User DID

Every user identity journey requires a unique Decentralized Identifier (DID) to cryptographically sign verification payloads.

> ⚠️ **Important Compliance Constraint**: Ensure that your data workflow enforces a strict **1:1 mapping** between a single user profile (e.g., unique internal user ID/email) and their generated DID entity.

```javascript
const users = {}; // Represents your persistent user Database table

async function registerUserDid(ssiAdminToken, email) {
    // 1. Search persistent persistence layer for pre-existing DID mappings
    const user = users[email];
    if (user && user.did) {
        return {
            email,
            did: user.did,
            verificationMethodId: user.verificationMethodId
        };
    }

    // 2. Fall back to generating a new identity reference structure on-chain
    const res = await fetch(`${SSI_BASE_URL}/api/v1/did/create`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ssiAdminToken}`
        },
        body: JSON.stringify({ namespace: '' })
    });
    
    const result = await res.json();
    if (!res.ok) throw new Error(`DID Creation Failed: ${result.message}`);
    
    // Extract target Ed25519 signature scheme details
    const method = result.metaData.didDocument.verificationMethod.find(
        m => m.type === 'Ed25519VerificationKey2020'
    );

    // 3. Persist state changes inside application storage boundaries
    users[email] = { did: result.did, verificationMethodId: method.id };
    
    return {
        email,
        did: result.did,
        verificationMethodId: method.id
    };
}

```

### STEP 3: Initialize the KYC Verification Session

Instantiate a remote verification journey record state block.

> ⏳ **Session Lifespan**: KYC state tracks a maximum validity window of **24 hours**.

```javascript
const userKycSessions = {}; // Local session reference matrix mapping tracking table

async function initializeVerificationSession(kycAdminToken, email) {
    const response = await fetch(`${KYC_BASE_URL}/api/v2/session`, {
        method: 'POST',
        headers: {
            'x-kyc-access-token': kycAdminToken,
            'Content-Type': 'application/json'
        }
    });

    const result = await response.json();
    if (!response.ok) throw new Error(`Session Init Failed: ${result.message}`);
    
    const sessionId = result.data.sessionId;

    // Persist session locally with pending validation flag
    userKycSessions[email] = {
        email,
        sessionId,
        isVerified: false
    };
  
    return sessionId;
}

```

### STEP 4: Generate User-Specific Bearer Token

Issue highly restricted, temporary user token for the frontend widget that can only be used to complete the current user's specific KYC session.

```javascript
async function generateKycUserSessionToken(claims, kycAdminToken, ssiAdminToken, sessionId) {
    // A. Issue a DID-signed administrative JWT wrapper declaring user identity claims
    const ssiRes = await fetch(`${SSI_BASE_URL}/api/v1/did/auth/issue-jwt`, {
        method: "POST",
        headers: { 
            "Authorization": `Bearer ${ssiAdminToken}`, 
            "Content-Type": "application/json" 
        },
        body: JSON.stringify({
            issuer: { verificationMethodId: X_ISSUER_VERMETHOD_ID, did: X_ISSUER_DID },
            audience: KYC_BASE_URL,
            claims: claims, 
            ttlSeconds: 3600
        })
    });
    
    const ssiResult = await ssiRes.json();
    if (!ssiRes.ok) throw new Error(`SSI JWT Issuance Failed: ${ssiResult.message}`);
    const { accessToken: didJwt } = ssiResult;

    // B. Exchange the DID-signed assertion JWT wrapper for a scoped User Access token
    const kycRes = await fetch(`${KYC_BASE_URL}/api/v2/auth/exchange`, {
        method: "POST",
        headers: {
            "x-ssi-access-token": ssiAdminToken,
            "x-kyc-access-token": kycAdminToken,
            "Authorization": `Bearer ${didJwt}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ provider: "client_auth", sessionId })
    });
    
    const finalResult = await kycRes.json();
    if (!kycRes.ok) throw new Error(`KYC Token Exchange Failed: ${finalResult.message}`);
    
    return finalResult.data.kycServiceUserAccessToken;
}

```

> **NOTE:** user's `claims` field MUST contain `did` and `email` fields

### STEP 5: Composite Orchestration Route

Expose a single unified endpoint to provision the client onboarding setup details:

```javascript
app.post('/api/v1/onboarding/setup', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: "Missing identity parameter 'email'" });
        }

        // 1. Resolve administrative application boundary tokens
        const kycAdminToken = await fetchAdminAccessToken(process.env.KYC_API_SECRET, 'access_service_kyc');
        const ssiAdminToken = await fetchAdminAccessToken(process.env.SSI_API_SECRET, 'access_service_ssi');

        // 2. Provision identity context structures
        const userClaims = await registerUserDid(ssiAdminToken, email);

        // 3. Instantiate transactional session reference
        const sessionId = await initializeVerificationSession(kycAdminToken, email);

        // 4. Derive isolated frontend action assertion token context 
        const userBearerToken = await generateKycUserSessionToken(
            userClaims, // user's `claims` field MUST contain `did` and `email` fields
            kycAdminToken,
            ssiAdminToken,
            sessionId
        );

        // 5. Package and emit execution parameters safely to client space
        res.status(200).json({
            kycAdminToken,
            ssiAdminToken,
            userBearerToken,
            sessionId,
        });

    } catch (error) {
        console.error(`[Onboarding Flow Error]:`, error);
        res.status(500).json({ error: "Internal initialization process failure" });
    }
});

```

---

## 4. Frontend Implementation

### Step 1: Client Workspace Handshake

Query your secure application backend domain endpoints to collect the runtime authorization variables.

```javascript
let state = null;

async function initKycUI(userEmail) {
    const response = await fetch(`/api/v1/onboarding/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail }),
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to initialize setup credentials");

    // Initialize state mapping matrix safely inside local runtime space
    state = {
        tokens: { 
            kycAdmin: data.kycAdminToken, 
            ssiAdmin: data.ssiAdminToken, 
            userBearer: data.userBearerToken 
        },
        session: { id: data.sessionId },
    };
}

```

### Step 2: Render & Orchestrate Verification Window

Build the Widget URL with the required security tokens and embede in your frontend

```javascript
const WIDGET_BASE_URL = "https://verify.hypersign.id";
let widgetCloseTimer = null;

function buildWidgetUrl() {
    const url = new URL(WIDGET_BASE_URL);
    url.searchParams.set("kycAccessToken", state.tokens.kycAdmin);
    url.searchParams.set("ssiAccessToken", state.tokens.ssiAdmin);
    url.searchParams.set("sessionId", state.session.id);
    url.searchParams.set("kycUserAccessToken", state.tokens.userBearer);
    return url.toString();
}

function openVerificationFlow() {
    const targetUrl = buildWidgetUrl();
    const widgetWindow = window.open(targetUrl, 'hypersignKycWidget', 'width=440,height=900,resizable=yes');

    if (!widgetWindow) {
        throw new Error("Navigation Container Blocked. Please check browser pop-up permissions.");
    }

    // Monitor for abrupt window exit actions
    widgetCloseTimer = window.setInterval(() => {
        if (!widgetWindow || widgetWindow.closed) {
            window.clearInterval(widgetCloseTimer);
            handleWidgetTermination();
        }
    }, 1000);
}

function handleWidgetTermination() {
    console.log("Verification modal interaction window was altered or closed by user.");
}

// Global interface processing event router loop hooks
window.addEventListener('message', function (event) {
    try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        const { status, message, code } = payload;
        
        if (status === 'success' && code === 'VERIFICATION_SUCCESS') {
            window.clearInterval(widgetCloseTimer);
            console.log("Client phase completed successfully:", message);
            // Frontend UI can transition to a "Processing" state here while waiting for the webhook
        } else if (status === 'error') {
            window.clearInterval(widgetCloseTimer);
            handleKycErrorStates(code);
        }
    } catch (err) {
        console.error("Failed to parse runtime context message data", err);
    }
});

function handleKycErrorStates(code) {
    switch (code) {
        case "SESSION_EXPIRED":
            alert("Verification timeline session expired. Please restart registration.");
            break;
        case "ACCESS_TOKEN_EXPIRED":
            alert("Security challenge tokens out of date.");
            break;
        case "LIVELINESS_VERIFICATION_FAILED":
            alert("Biometric validation check failed matching parameters.");
            break;
        case "DOCUMENT_VERIFICATION_FAILED":
            alert("Provided identification documents failed recognition profile rules.");
            break;
        case "ZK_PROOF_GENERATION_FAILED":
            alert("Cryptographic zero-knowledge zero-bounds proofs signature construction failure.");
            break;
        default:
            alert("An unhandled exception event took place during verification processing.");
    }
}

```

> Widget URL Format:
> `https://verify.hypersign.id?kycAccessToken=<kycAccessToken>&ssiAccessToken=<ssiAccessToken>&sessionId=<sessionId>&kycUserAccessToken=<kycUserAccessToken>`
---

## 5. Webhook Integration

### Step 1: Expose Webhook Route

To consume async confirmation messages emitted by the Hypersign verification services engine, map a public endpoint inside your backend router.

```
+--------------------------------+              +-------------------------+
| Hypersign Verification Service |              |  Your Application Host  |
+--------------------------------+              +-------------------------+
            |                                        |
            | --- [POST /api/v1/webhook/kyc] ------->|  (Extract idToken)
            |                                        |
            | <--- [GET /user-consent?idToken=...] --|  (Fetch Verification Data)
            |                                        |
            | ---- [Returns JSON Credential] ------->|  (Update Database state)

```

Configure your route location setup (e.g., `https://yourdomain.com/api/v1/webhook/kyc`) in the **Hypersign ID Dashboard** under Webhook Configurations.

### Step 2: Handle Webhook Events & Verify User Consent

Webhooks work via a **Fire-and-Forget** architectural notification strategy. When an evaluation lifecycle phase registers adjustments, the server pushes identity signatures containing data reference points directly to your destination handler:

#### Expected Webhook Payload Structure

```json
{
   "idToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
   "sessionId": "8814e6d0-1f5f-458b-8b58-fe413de19774"
}

```

### Step 3: Listening to webhook to received idToken

Once verification is complete, Hypersign sends a webhook notification to your configured endpoint.

Your webhook handler should:

1. Extract the idToken from the webhook payload.
2. Store or process the idToken for the next step.

```javascript

app.post('/api/v1/webhook/kyc', async (req, res) => {
    try {
        const { idToken, sessionId } = req.body;
        
        // Return 200 immediately to prevent timing timeouts on Hypersign framework
        res.status(200).json({ received: true });
        // Store or process the idToken for the next step
        console.log("Received idToken:", idToken);
    } catch (webhookProcessingError) {
        console.error(`[Webhook Process Processing Error Event]:`, webhookProcessingError);
    }
});

```
### Step 4 (Optional): Check consent status when a webhook is unavailable

Use this server-side fallback when your application cannot receive the webhook, for example because the configured webhook endpoint is temporarily unreachable.

```http
GET /api/v2/consents/{sessionId}
x-kyc-access-token: <kycAdminToken>
```

Once verification is complete, the response contains an `idToken`. Use this `idToken` exactly the same way as the one received from the webhook. The next step explains how to retrieve the verification result using the `idToken`..

```json
{
  "success": true,
  "message": "success",
  "data": {
    "idToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
  }
}
```

If verification does not yet exist for the session, the response contains the progress recorded so far. This lets you identify the last completed step or the step that failed.

```json
{
  "success": true,
  "message": "success",
  "data": [
    {
      "stepName": "start",
      "status": "success",
      "createdAt": "2026-07-15T08:23:29.221Z"
    },
    {
      "stepName": "ocrIdDoc",
      "status": "fail",
      "errorCode": 1,
      "error": "error message",
      "createdAt": "2026-07-15T08:25:38.923Z"
    }
  ]
}
```
##### Progress response fields

| Field | Description |
|---|---|
| `stepName` | The verification step that generated the progress record. See [supported step names](#supported-step-names). |
| `status` | `success` when the step completed, or `fail` when it did not complete. |
| `errorCode` | Numeric failure code. Present for failed steps when the service provides a code. See the step-specific error-code tables below. |
| `error` | Human-readable error message for the failed step. |
| `createdAt` | ISO 8601 timestamp when the progress record was created. |

##### Supported step names

The `stepName` value is one of the following keys. The `start` value indicates that the verification session started; the remaining values identify the corresponding verification step.

| Step name | Description |
|---|---|
| `start` | Verification session started. |
| `liveliness` | Liveness/selfie verification. |
| `ocrIdDoc` | Document OCR and facial-authentication verification. |
| `zkProofVerification` | Zero-knowledge proof verification. |
| `userConsent` | User consent step. |
| `mintSBT` | Soulbound-token minting step. |

##### Liveliness error codes

| Error code | Error message |
|---|---|
| `0` | Liveness could not be assessed. |
| `1` | Possible spoof detected. |
| `2` | An unspecified error occurred in a field. |
| `4` | Evaluation failed due to bad image quality. |
| `5` | Face is too close to the camera. |
| `6` | Face not found in the image. |
| `7` | Face size is too small in the image. |
| `8` | Please face the camera directly. Your face angle is too steep for verification. |
| `9` | Could not evaluate due to the format of the images used. |
| `10` | Could not evaluate due to internal error |
| `11` | Error occurred during image preprocessing. |
| `12` | Multiple faces detected, only one is allowed. |
| `13` | The face is too close the border |
| `14` | The face is cropped. |
| `15` | A license error occurred. |
| `16` | The face is obstructed. |
| `17` | No liveness detected. |
| `18` | The person has their eyes closed |
| `66` | The eye is obstructed. |

##### Document OCR error codes (`ocrIdDoc`)

| Error code | Error message |
|---|---|
| `0` | Face check could not be performed. |
| `1` | Faces does not match |
| `2` | Face not found in the image. |
| `4` | Failed to perform face check due to the pose of the face. |
| `5` | Failed, due to problems in the extraction of the facial pattern |
| `6` | Failed, because document has already been verified in some other account with this service |

##### ZK proof verification error codes (`zkProofVerification`)

| Error code | Error message |
|---|---|
| `4` | ZK proof verification failed. |
| `5` | ZK proof requirement verification failed. |

### Step 5: Call verification API to retrieve data using `idToken`

Once you have obtained the `idToken` (either from the webhook or from the fallback API), use it to retrieve the complete verification result.

```http
GET /api/v1/e-kyc/verification/user-consent?idToken={idToken}
x-kyc-access-token: <kycAdminToken>
```

Example:

```javascript
const complianceVerificationUrl =
    `${KYC_BASE_URL}/api/v1/e-kyc/verification/user-consent?idToken=${idToken}`;

const response = await fetch(complianceVerificationUrl, {
    method: "GET",
    headers: {
        "x-kyc-access-token": kycAdminToken
    }
});

const consentDataResponse = await response.json();

  if (consentDataResponse && consentDataResponse.success) {
            const targetEmail = Object.keys(userKycSessions).find(email => userKycSessions[email].sessionId === sessionId);
                
            if (targetEmail) {
                // Update user profile status inside database state persistence
                userKycSessions[targetEmail].isVerified = true;
                userKycSessions[targetEmail].credentialId = userCredentialPayload.id;
                
                console.log(`Identity verified successfully for profile account path: ${targetEmail}`);
            }
        }
```

Example consentDataResponse for **Proof Of Age** consent:

```json
{
    "success": true,
    "message": "success",
    "data": {
        "sessionId": "1b5b9cea-45bb-4a26-b76b-61e4d4a4c744",
        "presentation": {
            "@context": [
                "https://www.w3.org/2018/credentials/v1"
            ],
            "type": [
                "VerifiablePresentation"
            ],
            "verifiableCredential": [
                {
                    "@context": [
                        "https://www.w3.org/2018/credentials/v1",
                        "https://raw.githubusercontent.com/hypersign-protocol/hypersign-contexts/main/BJJSignature2021.jsonld",
                        "https://schema.org"
                    ],
                    "id": "vc:hid:z6MkuZKDPydmCgv2K1ekV3m2weQ2G88SpibLE5HvN1Gm75uZ",
                    "type": [
                        "VerifiableCredential",
                        "zkProofOfAge"
                    ],
                    "issuer": "did:hid:z3YsrhDHXqceBf2LUs4nJZF4JXdGJwQv8gwqrYqTNM5DJ",
                    "issuanceDate": "2026-06-29T13:36:00Z",
                    "expirationDate": "2027-12-10T18:30:00Z",
                    "credentialSubject": {
                        "proof": {
                            "pi_a": "AUAAv/8bgOw32obJEwc0ECU..9wsgA",
                            "pi_b": "AYAAf/8RFt9mNF7JJv0..VD2LPsy5acCoFsPXheyUqLf8LFaXIWWLApXGhVG8K+8wbWbUqT6QA==",
                            "pi_c": "AUAAv/8TiZa9PEPIPwXeHB...hwZBTrua7MEkY7Yv",
                            "protocol": "groth16",
                            "curve": "bn128"
                        },
                        "publicSignals": [
                            "BcEBAQAwCAKwS...NG6he3tV+Hw==",
                            "MwQA",
                            "MzIAAA==",
                            "BcEBAQAwCAKwSn..K7vM7d0csbuqgHw==",
                            "FcOBDcAwDAKwl4A..uTbiMrInt9ODR8gM=",
                            "HcXBEQAwCAKwlV...Owo2PriSIaQ7WGz2gn4="
                        ],
                        "criteria": {
                            "type": "Requirement",
                            "attribute": "age",
                            "operator": ">",
                            "value": 20,
                            "unit": "years"
                        },
                        "criteriaVerified": true,
                        "id": "did:hid:z6MkjBaYmFA1qQPVrL22SUJipXUGeydJwtRC4fVWGUJFBE6m"
                    },
                    "credentialStatus": {
                        "id": "https://api.atman.hypersign.id/hypersign-protocol/hidnode/ssi/credential/vc:hid:z6MkuZKDPydmCgv2K1ekV3m2weQ2G88SpibLE5HvN1Gm75uZ",
                        "type": "HypersignCredentialStatus2023"
                    },
                    "proof": {
                        "type": "BJJSignature2021",
                        "created": "2026-06-29T13:37:42Z",
                        "verificationMethod": "did:hid:z3YsrhDHXqceBf2LUs4nJZF4JXdGJwQv8gwqrYqTNM5DJ#key-1",
                        "proofPurpose": "assertionMethod",
                        "proofValue": "z5ofZ6iAgYn896u65...5QkBiKjMofm5"
                    }
                }
            ],
            "id": "vp:hid:z6MkngSE9cDhPbgBLS2XC8yw3EKSxxrn14WvsEmxQb5ES4Qe",
            "holder": "did:hid:z6MkjBaYmFA1qQPVrL22SUJipXUGeydJwtRC4fVWGUJFBE6m"
        }
    }
}
```

---

# Troubleshooting

### Popup window is blocked

**Problem**

The verification widget does not open.

**Solution**

Most browsers block popups that are not triggered by a user action. Launch the widget only in response to a button click or another direct user interaction.

---

### Session Expired

**Error Code**

`SESSION_EXPIRED`

**Cause**

The verification session has expired (sessions are valid for 24 hours).

**Solution**

Create a new verification session by calling the Session API and launch the widget again.

---

### Access Token Expired

**Error Code**

`ACCESS_TOKEN_EXPIRED`

**Cause**

The KYC or SSI administrative access token has expired.

**Solution**

Generate a new administrative access token using your API Secret and retry the request.

---

### Document Verification Failed

**Error Code**

`DOCUMENT_VERIFICATION_FAILED`

**Cause**

The uploaded document could not be verified.

**Possible Reasons**

- Blurry image
- Unsupported document
- Partial document capture
- Damaged document

**Solution**

Ask the user to upload a clearer image or capture the document again.

---

### ZK Proof Generation Failed

**Error Code**

`ZK_PROOF_GENERATION_FAILED`

**Cause**

The widget failed while generating the zero-knowledge proof.

**Solution**

Retry the verification. If the issue persists, contact Hypersign Support.

---

### Webhook Not Received

**Possible Causes**

- Incorrect webhook URL
- Endpoint is not publicly accessible
- Server returned a non-2xx response
- Firewall blocked the request

**Solution**

- Verify the webhook URL configured in the Hypersign Dashboard.
- Ensure the endpoint is publicly accessible.
- Verify your server responds with HTTP 200.

---

### User Closed the Widget

If the user closes the popup before completing verification, simply allow them to launch the widget again.

The current verification session remains valid until it expires.
