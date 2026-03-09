# 📄 Hypersign KYC API Integration Guide

This document is for developers building a custom UI to integrate with **Hypersign KYC and SSI APIs**. By using these APIs directly instead of the pre-built widget, you maintain total control over your UI/UX while leveraging decentralized identity (DID) infrastructure.

---

## 1. Integration Architecture

The integration follows a **Security-First Handshake** model:

* **Backend:** Securely manages the `API_SECRET`, fetches administrative tokens, and registers User DIDs.
* **Frontend:** Handles the camera interface, performs OCR extraction, executes Face Match, and signs the final Consent via a Verifiable Presentation.

---

## 2. Base Configuration

### Service URLs
```js
const KYC_BASE_URL = "https://api.cavach.hypersign.id";
const SSI_BASE_URL = "https://api.entity.hypersign.id";
const DEVELOPER_DASHBOARD_SERVICE_BASE_URL = "https://api.entity.dashboard.hypersign.id"
```

### Prerequisite Setup
1.  **Dashboard Access:** Setup your account in the [Hypersign Dashboard](https://entity.dashboard.hypersign.id/).
2.  **Secrets:** Download your `SSI_API_SECRET` and `KYC_API_SECRET` from the app settings.
3.  **Issuer Information:** Copy your Issuer DID and Verification Method from the SSI dashboard:
    ```js
    const X_ISSUER_DID = "did:hid:z6MkmEFC8N1AUsinEBNSszXoepHb45p38ZwidV58r1HPqCkU";
    const X_ISSUER_VERMETHOD_ID = "did:hid:z6MkmEFC8N1AUsinEBNSszXoepHb45p38ZwidV58r1HPqCkU#key-1";
    ```

---

## 3. Backend Implementation (Node.js)

The backend acts as a secure proxy to ensure administrative keys are never exposed to the browser.

### STEP 1: Prepare Administrative Access Tokens
Administrative tokens for KYC and SSI services should be cached locally and refreshed only upon expiry.

```js
async function fetchAdminAccessToken(apiSecret, serviceType) {
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
  return result.access_token;
}
```

### STEP 2: Initialize the KYC Verification Session
Create a unique session for the user's verification journey.

```js
async function initializeVerificationSession
(kycAdminToken){
  const response = await fetch(`${KYC_BASE_URL}/api/v2/session`, {
    method: 'POST',
    headers: {
        'x-kyc-access-token': kycAdminToken,
        'Content-Type': 'application/json'
    }
  });

  const result = await response.json();
  return result.data.sessionId;
}
```

### STEP 3: Register User DID
Every user requires a DID to sign their final verification results.

```js
async function registerUserDid(ssiAdminToken) {
    const res = await fetch(`${SSI_BASE_URL}/api/v1/did/create`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ssiAdminToken}`
        },
        body: JSON.stringify({ namespace: '' })
    });
    const result = await res.json();
    
    // Find the Ed25519 key method required for signatures
    const method = result.metadata.didDocument.verificationMethods
                   .find(m => m.type === 'Ed25519VerificationKey2020');

    return {
        did: result.did,
        verificationMethodId: method.id
    };
}
```

### STEP 4: Generate User-Specific Bearer Token
This token authorizes the frontend to perform biometric actions for this specific session only.

```js
async function generateKycUserSessionToken(claims, kycAdminToken, ssiAdminToken, sessionId) {
    // A. Issue a DID-signed JWT
    const ssiRes = await fetch(`${SSI_BASE_URL}/api/v1/did/auth/issue-jwt`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ssiAdminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            issuer: { verificationmethodId: X_ISSUER_VERMETHOD_ID, did: X_ISSUER_DID },
            audience: KYC_BASE_URL,
            claims: claims,
            ttlSeconds: 3600
        })
    });
    const { accessToken: didJwt } = await ssiRes.json();

    // B. Exchange JWT for the KYC User Access Token
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
    return finalResult.data.kycServiceUserAccessToken;
}
```


### STEP 5: Implement an API to return relevate tokens in frontend

```js


app.get('/get-required-tokens-and-session-for-a-user', async (req, res) => {
    try {
        // 1. Prepare Administrative Access Tokens (using file-based cache)
        const kycAdminToken = await fetchAdminAccessToken(KYC_API_SECRET, 'access_service_kyc') // Generate KYC Access Token
        const ssiAdminToken = fetchAdminAccessToken(SSI_API_SECRET, 'access_service_ssi') // Generate SSI Access Token

        // 2. Initialize the KYC Verification Session
        const sessionId = await initializeVerificationSession(kycAdminToken);

        // 3. Register a new User DID
        const userDidMetadata = await registerUserDid(ssiAdminToken);

        // 4. Prepare User Claims for the DID JWT
        const userData = {
            name: "John",
            email: "john@gmail.com", // Mandatory
            userDid: userDidMetadata.did, // Mandatory
        };

        // 5. Generate the final User-specific Bearer Token
        const userBearerToken = await generateKycUserSessionToken(
            userData,
            kycAdminToken,
            ssiAdminToken,
            sessionId
        );

        // 6. Return comprehensive credentials to the client
        res.json({
            kycAdminToken,
            ssiAdminToken,
            userBearerToken,
            issuerDid: X_ISSUER_DID,
            issuerVerificationMethodId: X_ISSUER_VERMETHOD_ID,
            sessionId,
            userDid: userDidMetadata.did,
            userVerificationMethodId: userDidMetadata.verificationMethodId
        });

    } catch (error) {
        console.error(`[Onboarding Flow Error]: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
});
```

---
## 4. Frontend Implementation

### Step 1: Initialize Session
Call your backend endpoint to receive all necessary session and admin tokens.

```js
async function initKycUI() {
    const response = await fetch(`/get-required-tokens-and-session-for-a-user`);
    const data = await response.json();

    // Map backend response to local state
    const state = {
        tokens: { 
            kycAdmin: data.kycAdminToken, 
            ssiAdmin: data.ssiAdminToken, 
            userBearer: data.userBearerToken 
        },
        session: { id: data.sessionId },
        user: { did: data.userDid, methodId: data.userVerificationMethodId },
        issuer: { did: data.issuerDid, methodId: data.issuerVerificationMethodId }
    };
}
```

### Step 2: Document OCR Extraction
After capturing the ID document via the camera, send the Base64 image for extraction.

### Option A: Passport Extraction
For passports, only the front image (the information page) is required in the request payload.

```js
async function processDocumentExtraction(base64Image) {
    const response = await fetch(`${KYC_BASE_URL}/api/v2/documents/extract`, {
        method: 'POST',
        headers: {
            'x-kyc-access-token': state.tokens.kycAdmin,
            'Authorization': `Bearer ${state.tokens.userBearer}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            documentFront: base64Image,
            sessionId: state.session.id,
            documentType: "PASSPORT" 
        })
    });

    const result = await response.json();
    state.session.extractionToken = result.data.extractionToken;
}
```

### Option B: Government ID Extraction

For Government IDs, the API expects both front and back images, along with a specific ISO country code.

```js
async function processDocumentExtraction(base64Image) {
    const response = await fetch(`${KYC_BASE_URL}/api/v2/documents/extract`, {
        method: 'POST',
        headers: {
            'x-kyc-access-token': state.tokens.kycAdmin,
            'Authorization': `Bearer ${state.tokens.userBearer}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            documentFront: base64ImageFront,
            documentBack: base64ImageBack,
            sessionId: state.session.id,
            documentType: "GOVT_ID",
            countryCode: "IND" // ISO Alpha-3 code (e.g., IND for India)
        })
    });

    const result = await response.json();
    state.session.extractionToken = result.data.extractionToken;
}
```

### Step 3: Identity Verification (Face Match)
Matches the selfie against the extracted document data.

```js
async function performIdentityMatch(base64Selfie) {
    const response = await fetch(`${KYC_BASE_URL}/api/v2/biometrics/verify`, {
        method: 'POST',
        headers: {
            'x-kyc-access-token': state.tokens.kycAdmin,
            'x-issuer-did': state.issuer.did,
            'x-issuer-did-ver-method': state.issuer.methodId,
            'Authorization': `Bearer ${state.tokens.userBearer}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            documentToken: state.session.extractionToken,
            sessionId: state.session.id,
            selfieImage: base64Selfie,
            holderDid: state.user.did,
        })
    });

    const result = await response.json();
    if (result.success) {
        await submitUserConsent(result.data.credentials);
    }
}
```

### Step 4: Final Consent & SSI Presentation
Finalize the process by creating a Verifiable Presentation and submitting it to the KYC service.

```js
async function submitUserConsent(credentials) {
    // 1. Create Presentation via SSI API
    const vpRes = await fetch(`${SSI_BASE_URL}/api/v1/presentation`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${state.tokens.ssiAdmin}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            credentialDocuments: credentials,
            holderDid: state.user.did,
            challenge: state.session.id,
            domain: window.location.origin,
            verificationMethodId: state.user.methodId
        })
    });
    const vpData = await vpRes.json();

    // 2. Submit Final Consent to KYC Service
    await fetch(`${KYC_BASE_URL}/api/v2/consents`, {
        method: 'POST',
        headers: { 
            'x-kyc-access-token': state.tokens.kycAdmin,
            'Authorization': `Bearer ${state.tokens.userBearer}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sessionId: state.session.id,
            presentation: vpData.presentation
        })
    });
}
```


---




