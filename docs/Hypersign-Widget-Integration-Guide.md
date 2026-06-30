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

#### Step 3: Implement Webhook Listener and Token Verification

Upon receiving the payload, make a back-channel request using your `kycAccessToken` to download the fully verified data packet structures.

```javascript
app.post('/api/v1/webhook/kyc', async (req, res) => {
    try {
        const { idToken, sessionId } = req.body;
        
        // Return 200 immediately to prevent timing timeouts on Hypersign framework
        res.status(200).json({ received: true });

        // Retrieve background administrative tokens to perform the lookups
        const kycAdminToken = await fetchAdminAccessToken(process.env.KYC_API_SECRET, 'access_service_kyc');

        // Request full document parsing using the verification identity token payload
        const complianceVerificationUrl = `${KYC_BASE_URL}/api/v1/e-kyc/verification/user-consent?idToken=${idToken}`;
        
        const dataFetchResponse = await fetch(complianceVerificationUrl, {
            method: 'GET',
            headers: {
                'x-kyc-access-token': kycAdminToken
            }
        });

        const consentDataResult = await dataFetchResponse.json();
        
        if (consentDataResult && consentDataResult.success) {
            const targetEmail = Object.keys(userKycSessions).find(email => userKycSessions[email].sessionId === sessionId);
                
            if (targetEmail) {
                // Update user profile status inside database state persistence
                userKycSessions[targetEmail].isVerified = true;
                userKycSessions[targetEmail].credentialId = userCredentialPayload.id;
                
                console.log(`Identity verified successfully for profile account path: ${targetEmail}`);
            }
        }
    } catch (webhookProcessingError) {
        console.error(`[Webhook Process Processing Error Event]:`, webhookProcessingError);
    }
});

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
