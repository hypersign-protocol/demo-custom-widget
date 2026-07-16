# 📄 Hypersign KYB API Integration Guide

This document describes the **Hypersign KYB Business Verification** integration using APIs. It focuses on the KYB-specific token handshake, backend orchestration, and KYB API request/response contracts.

---

## 1. Integration Architecture

The KYB flow uses a secure backend proxy model:

* **Backend:** stores `KYC_API_SECRET` and `SSI_API_SECRET`, obtains administrative tokens, registers or reuses a user DID, and issues scoped KYB bearer tokens.
* **Frontend:** consumes the issued tokens to call KYB APIs for document upload, company creation, UBO/executive management, and compliance queries.
* **Hypersign services:** KYB and SSI validate business data and DID proofs.

---

## 2. Base Configuration

### Service URLs

Configure these endpoints in `config.js` or environment variables:

```js
const KYC_BASE_URL = "https://api.cavach.hypersign.id";
const SSI_BASE_URL = "https://api.entity.hypersign.id";
const DEVELOPER_DASHBOARD_SERVICE_BASE_URL = "https://api.entity.dashboard.hypersign.id"
```

### Required backend secrets

Keep the following secrets on the backend only:

```env
KYC_API_SECRET=
SSI_API_SECRET=
ISSUER_DID=
ISSUER_VERMETHOD_ID=
```

The issuer DID and verification method are needed to request a DID-signed JWT from the SSI service.

---

## 3. Backend Implementation (Node.js)

The backend hosts the secure KYB token handshake and returns only runtime tokens to the frontend.

### STEP 1: Fetch administrative access tokens

Administrative tokens are issued by the Hypersign Developer Dashboard and should be cached server-side.

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

### STEP 2: Register or reuse a user DID

A KYB frontend user requires a DID so the backend can issue a DID-signed JWT.

```js
async function registerUserDid(ssiAdminToken, email) {
  const res = await fetch(`${SSI_BASE_URL}/api/v1/did/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ssiAdminToken}`
    },
    body: JSON.stringify({ namespace: '' })
  });

  const result = await res.json();
  const method = result.metaData.didDocument.verificationMethod.find(
    m => m.type === 'Ed25519VerificationKey2020'
  );

  return {
    did: result.did,
    verificationMethodId: method.id
  };
}
```

### STEP 3: Generate the KYB user bearer token

Issue a DID-signed JWT via the SSI service, then exchange it for a scoped KYB user bearer token. The exchange request must include `x-kyb-access-token` and does not require a `sessionId`.

```js
async function generateKybUserToken(claims, kybAdminToken, ssiAdminToken) {
  const ssiRes = await fetch(`${SSI_BASE_URL}/api/v1/did/auth/issue-jwt`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ssiAdminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      issuer: { verificationMethodId: X_ISSUER_VERMETHOD_ID, did: X_ISSUER_DID },
      audience: KYC_BASE_URL,
      claims,
      ttlSeconds: 3600
    })
  });

  const { accessToken: didJwt } = await ssiRes.json();

  const kybRes = await fetch(`${KYC_BASE_URL}/api/v2/auth/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ssi-access-token': ssiAdminToken,
      'x-kyb-access-token': kybAdminToken,
      'Authorization': `Bearer ${didJwt}`
    },
    body: JSON.stringify({ provider: 'client_auth' })
  });

  const finalResult = await kybRes.json();
  return finalResult.data.kycServiceUserAccessToken;
}
```

### STEP 4: Return runtime tokens to the client

Expose a secure endpoint that returns only the tokens the frontend needs.

```js
app.post('/get-required-tokens-and-session-for-a-user', async (req, res) => {
  try {
    const { name, email } = req.body;
    const { kybAdminToken, ssiAdminToken } = await getCachedAdminTokens();
    const userDidMetadata = await registerUserDid(ssiAdminToken, email);

    const userBearerToken = await generateKybUserToken(
      { name, email, did: userDidMetadata.did },
      kybAdminToken,
      ssiAdminToken
    );

    res.json({
      kybAdminToken,
      ssiAdminToken,
      userBearerToken,
      issuerDid: X_ISSUER_DID,
      issuerVerificationMethodId: X_ISSUER_VERMETHOD_ID,
      userDid: userDidMetadata.did,
      userVerificationMethodId: userDidMetadata.verificationMethodId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

---

## 4. KYB API Reference

This section documents the main KYB APIs for business document verification.

### 4.1 Upload business documents
Upload both the Certificate of Incorporation and Proof of Address documents, and keep their document IDs. These document IDs are required when creating the company.

#### Request

```http
POST /api/v1/document/upload
Authorization: Bearer <userBearerToken>
 x-kyb-access-token: <kybAdminToken>
 x-ssi-access-token: <ssiAdminToken>
Content-Type: multipart/form-data
```

Form fields:

* `file` — document binary
* `entityType` — `Company` 
* `documentType` — `CertificateOfIncorporation` or `ProofOfAddress`

#### Response

```json
{
  "success": true,
  "message": "success",
  "data": {
    "id": "68ca42453c3d86f143cf43b3",
    "fileName": "proof-of-address.pdf",
    "documentType": "ProofOfAddress",
    "verification": {
      "status": "Submitted"
    }
  }
}
```

### 4.2 Create a company verification

#### Request

```http
POST /api/v1/e-kyb/verification/company
Authorization: Bearer <userBearerToken>
 x-kyb-access-token: <kybAdminToken>
 x-ssi-access-token: <ssiAdminToken>
Content-Type: application/json
```

Body:

```json
{
  "name": "Acme Corporation",
  "domain": "acme.example",
  "region": "Asia Pacific",
  "countryOfRegistration": "IN",
  "registrationNumber": "123456789",
  "registrationNumberType": "CIN",
  "address": {
    "street": "123 Business St",
    "province": "Karnataka",
    "city": "Bangalore",
    "postalCode": "560001",
    "country": "IN"
  },
  "documentIds": ["<doc-id-1>", "<doc-id-2>"]
}
```

#### Response

```json
{
  "success": true,
  "message": "success",
  "data": {
    "name": "Acme Corporation",
    "domain": "acme.example",
    "region": "Asia Pacific",
    "countryOfRegistration": "IN",
    "registrationNumber": "123456789",
    "registrationNumberType": "CIN",
    "address": {
      "street": "123 Business St",
      "province": "Karnataka",
      "city": "Bangalore",
      "postalCode": "560001",
      "country": "IN"
    },
    "status": "Submitted",
    "documents": [
      {
        "id": "<doc-id-1>",
        "documentType": "CertificateOfIncorporation",
        "fileName": "certificate.pdf",
        "verification": {
          "status": "Submitted"
        }
      }
    ],
    "_id": "<company-id>",
    "createdAt": "2025-08-22T09:20:21.907Z",
    "updatedAt": "2025-08-22T09:22:21.907Z"
  }
}
```

### 4.3 Fetch an existing company

#### Request

```http
GET /api/v1/e-kyb/verification/company/{companyId}
Authorization: Bearer <userBearerToken>
 x-kyb-access-token: <kybAdminToken>
```

#### Response

```json
{
  "success": true,
  "message": "success",
  "data": {
    "company": {
      "id": "<company-id>",
      "name": "Acme Corporation",
      "status": "Submitted",
      "registrationNumber": "123456789",
      "registrationNumberType": "CIN",
      "address": {
        "street": "123 Business St",
        "province": "Karnataka",
        "city": "Bangalore",
        "postalCode": "560001",
        "country": "IN"
      },
      "documents": [
        {
          "id": "<doc-id-1>",
          "documentType": "CertificateOfIncorporation",
          "fileName": "certificate.pdf",
          "verification": {
            "status": "Submitted"
          }
        }
      ],
      "createdAt": "2025-08-22T09:20:21.907Z",
      "updatedAt": "2025-08-22T09:22:21.907Z"
    }
  }
}
```

### 4.4 Add UBO / executive records

The person submitting the business verification details can be either a `Shareholder` or a `Representative`.

* If they are a shareholder, add them as `type: "Shareholder"` and include their share percentage.
* If they are a Representative: upload a `PowerOfAttorney` document first with `entityType` — `Individual` via `POST /api/v1/document/upload` to obtain its `documentId`. Then call the `PATCH /api/v1/e-kyb/verification/company/{companyId}/company-executives` endpoint with `type: "Representative"` and include a `documentIds` array containing the Power of Attorney `documentId` (example request/response shown below).

Note: Prefer the simple flows developers will use most often.

- Add Shareholders and executives using `POST /company-executives`.
- If a user is both a shareholder and the company's representative, add them as a `Shareholder` (POST); no Power of Attorney is required.
- Use `PATCH /company-executives` only when attaching or updating a Representative's Power of Attorney — include the POA `documentId` in `documentIds`.
Note: The `PATCH /company-executives` endpoint accepts the same request body shape as the `POST` example above. When updating a Representative, include the `documentIds` field with the Power of Attorney `documentId`.

> Note: To perform KYC for UBO, generate a new `kycAdminToken` by passing the `businessId`, and then continue with the same flow described in the [Hypersign API Custom Widget Integration Guide](./Hypersign-API-Custom-Widget-Integration-Guide.md).

#### Request

```http
POST /api/v1/e-kyb/verification/company/{companyId}/company-executives
Authorization: Bearer <userBearerToken>
 x-kyb-access-token: <kybAdminToken>
 x-ssi-access-token: <ssiAdminToken>
Content-Type: application/json
```

Body:

```json
{
  "name": "John Doe",
  "email": "john@gmail.com",
  "designation": "CEO",
  "type": "Shareholder",
  "percentageShare": 25
}
```

#### Response

```json
{
  "success": true,
  "message": "success",
  "data": {
    "name": "John Doe",
    "email": "john@gmail.com",
    "designation": "CEO",
    "type": "Shareholder",
    "percentageShare": 25,
    "_id": "68a836556e413867472763e1",
    "createdAt": "2025-08-22T09:20:21.907Z",
    "updatedAt": "2025-08-22T09:22:21.907Z",
    "mailSent": true
  }
}
```

### 4.5 Update a Representative

If the person completing the form is the company representative, use the PATCH endpoint to add or update the representative data.

#### Request

```http
PATCH /api/v1/e-kyb/verification/company/{companyId}/company-executives
Authorization: Bearer <userBearerToken>
 x-kyb-access-token: <kybAdminToken>
 x-ssi-access-token: <ssiAdminToken>
Content-Type: application/json
```

Body:

```json
{
  "name": "xyz",
  "email": "xyz@gmail.com",
  "designation": "developer",
  "type": "Representative",
  "percentageShare": 0,
  "documentIds": ["6a54c4a3d635deb3a95e8319"]
}
```

#### Response

```json
{
  "success": true,
  "message": "success",
  "data": {
    "_id": "6a54c1e8d2738bb62870a8a4",
    "companyId": "6a54c1e7d635deb3a95e82de",
    "emailHash": "603fc5abf6bd0696845d82c34e543d5017dd509c87a75936c500eba186892d2c",
    "type": "Representative",
    "__v": 0,
    "createdAt": "2026-07-13T10:46:00.028Z",
    "companyId": "6a54c1e7d635deb3a95e82de",
    "email": "hs:doc:dxvehl6bwlimjaga-u_nznfjujsoohoao9hf_yblpny",
    "mailSent": true,
    "name": "xyz",
    "updatedAt": "2026-07-13T10:57:57.192Z",
    "designation": "developer",
    "percentageShare": 0,
    "documents": {
      "id": "6a54c4a3d635deb3a95e8319",
      "fileName": "powerOfAttorney.pdf",
      "documentType": "PowerOfAttorney"
    }
  }
}
```

### 4.6 Compliance status

#### Request

```http
GET /api/v1/compliance?entityId=<entity-id>
Authorization: Bearer <userBearerToken>
 x-kyc-access-token: <kyc-service-token>
```

Query parameters:

* `entityId` — required string identifier for the company.

#### Response

```json
{
  "success": true,
  "message": "success",
  "data": {
    "entityType": "Company",
    "companyId": "68a836556e413867472763e1",
    "registryCheck": {
      "status": "Failed",
      "updatedAt": "2025-08-22T09:22:21.907Z",
      "reasonDetail": "Address is not matched.",
      "reason": "COMPANY_FIELDS_MISMATCH"
    },
    "_id": "68a836556e4138656782763e1",
    "createdAt": "2025-08-22T09:20:21.907Z",
    "updatedAt": "2025-08-22T09:22:21.907Z",
    "adverseMediaChecks": {
      "status": "Success",
      "updatedAt": "2025-08-22T09:22:21.907Z",
      "reasonDetail": null,
      "reason": null
    }
  }
}
```

### Recommended flow

1. Request KYB startup tokens from the backend.
2. Upload business documents.
3. Create the company verification.
4. Add UBOs/executives.
5. Query compliance details.

---

## 6. Common implementation tips

* Cache admin tokens on the backend and refresh only when expired.
* Use returned `documentIds` for company creation.
* Keep secrets off the client.
* Persist `companyId` for the rest of the KYB flow.
