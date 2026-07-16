# 📄 Hypersign KYB API Integration Guide

This document describes how to integrate **Hypersign KYB Business Verification** through its APIs. It focuses on the KYB-specific token handshake, backend orchestration, and KYB API request/response contracts.

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
const DEVELOPER_DASHBOARD_SERVICE_BASE_URL = "https://api.entity.dashboard.hypersign.id";
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

#### Form Fields

| Field | Type | Description | Supported values / format |
|---|---|---|---|
| `file` | File (binary) | The business document to upload. | PDF, JPG, JPEG, PNG, or GIF. |
| `entityType` | String (enum) | The entity to which the document relates. | `Company` or `Individual`; see [supported entity types](#supported-entity-types). |
| `documentType` | String (enum) | Classifies the document so it can be used in the appropriate KYB step. | `CertificateOfIncorporation`, `ProofOfAddress`, or `PowerOfAttorney`; see [supported-document-types](#supported-document-types). |

##### Supported entity types

| Value | Description | Use with |
|---|---|---|
| `Company` | A legal business entity being verified. | `CertificateOfIncorporation` and `ProofOfAddress` when creating a company verification. |
| `Individual` | A natural person associated with the company. | `PowerOfAttorney` for a company representative. |

##### Supported document types

| Value | Description | Entity type |
|---|---|---|
| `CertificateOfIncorporation` | Official document that proves the company was legally incorporated or registered. | `Company` |
| `ProofOfAddress` | Document that substantiates the company's registered or operating address. | `Company` |
| `PowerOfAttorney` | Document authorizing an individual to act on the company's behalf. It is required when adding or updating a `Representative`. | `Individual` |

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

#### Verification status meanings

The company `status` field supports the following values:

| Status | Meaning |
|---|---|
| `Submitted` | Default status when a company is added. KYB verification has not yet started. |
| `InProgress` | KYB verification has started. |
| `Approved` | Company KYB verification completed successfully and was approved by the customer. |
| `Rejected` | Company KYB verification completed and was rejected by the customer. |
| `Completed` | Company KYB verification is finished, regardless of whether the outcome was successful or unsuccessful. |

> `Success` and `Failed` in the compliance response describe the outcome of an individual compliance check. They are not company verification status values.

### 4.2 Create a company verification

#### Request

```http
POST /api/v1/e-kyb/verification/company
Authorization: Bearer <userBearerToken>
x-kyb-access-token: <kybAdminToken>
x-ssi-access-token: <ssiAdminToken>
Content-Type: application/json
```

Request body:

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

#### Request body fields

| Field name | Type | Description | Supported values / format |
|---|---|---|---|
| `name` | String | Legal or trading name of the company. | Free text. |
| `domain` | String | Company's internet domain. | Domain name, for example `acme.example`. |
| `region` | String | Geographic region in which the company operates or is registered. | Free text, for example `Asia Pacific`. |
| `countryOfRegistration` | String | Country where the company is registered. | ISO 3166-1 alpha-2 country code, for example `IN`. |
| `registrationNumber` | String | Company registration number assigned by the relevant authority. | Use the format issued by the registering authority. |
| `registrationNumberType` | String | Name of the registration-number scheme. | Jurisdiction-specific value; for example, `CIN` for an Indian Corporate Identification Number. |
| `address` | Object | Registered business address. | Object containing the address fields below. |
| `address.street` | String | Street address, including building or unit information where applicable. | Free text. |
| `address.province` | String | State, province, or other first-level administrative area. | Free text. |
| `address.city` | String | City or locality. | Free text. |
| `address.postalCode` | String | Postal or ZIP code for the registered address. | Use the format defined by the address country. |
| `address.country` | String | Country of the registered address. | ISO 3166-1 alpha-2 country code, for example `IN`. |
| `documentIds` | Array of strings | IDs of the company documents returned by the upload API. | Include the IDs for the uploaded `CertificateOfIncorporation` and `ProofOfAddress` documents. |

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

* If they are a shareholder, add them with `type: "Shareholder"` and include their share percentage.
* If they are a representative, first upload a `PowerOfAttorney` document with `entityType: "Individual"` using `POST /api/v1/document/upload` to obtain its `documentId`. Then call `PATCH /api/v1/e-kyb/verification/company/{companyId}/company-executives` with `type: "Representative"` and a `documentIds` array containing the Power of Attorney document ID. An example request and response are shown below.

- Add shareholders and executives using `POST /company-executives`.
- If a user is both a shareholder and the company's representative, add them as a `Shareholder` (POST); no Power of Attorney is required.
- Use `PATCH /company-executives` only when attaching or updating a Representative's Power of Attorney — include the POA `documentId` in `documentIds`.

The `PATCH /company-executives` endpoint accepts the same request-body shape as the `POST` example above. When updating a representative, include the Power of Attorney `documentId` in `documentIds`.

> To perform KYC for a UBO, generate a new `kycAdminToken` by passing the `businessId`, then follow the flow described in the [Hypersign API Custom Widget Integration Guide](./Hypersign-API-Custom-Widget-Integration-Guide.md).

#### Request

```http
POST /api/v1/e-kyb/verification/company/{companyId}/company-executives
Authorization: Bearer <userBearerToken>
x-kyb-access-token: <kybAdminToken>
x-ssi-access-token: <ssiAdminToken>
Content-Type: application/json
```

Request body:

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

Request body:

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
x-kyb-access-token: <kybAdminToken>
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
