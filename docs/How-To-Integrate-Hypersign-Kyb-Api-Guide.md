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
| `file` | File (binary) | The business document to upload. | PDF, JPG, JPEG, PNG, or GIF. Maximum size: `5242880` bytes (5 MiB). |
| `entityType` | String (enum) | The entity to which the document relates. | `Company` or `Individual`. |
| `documentType` | String (enum) | Classifies the document so it can be used in the appropriate KYB step. | `CertificateOfIncorporation`, `ProofOfAddress`, or `PowerOfAttorney`; see [supported-document-types](#supported-document-types). |

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

#### Document verification status meanings

The document `verification.status` field supports the following values:

| Status | Meaning |
|---|---|
| `Submitted` | Document uploaded, waiting to be verified. |
| `InProgress` | Verification process is ongoing. |
| `Verified` | Document is authentic and approved. |
| `Rejected` | Document failed verification. |

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
  "registrationNumber": "U12345KA2024PLC123456",
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
| `countryOfRegistration` | String (enum) | Country where the company is officially registered. | One of the supported ISO 3166-1 alpha-2 codes; see [supported countries of registration](#supported-countries-of-registration). |
| `registrationNumber` | String | Unique company registration number issued by the relevant authority. | Required. Its format must match the selected `registrationNumberType`. |
| `registrationNumberType` | String (enum) | Registration-number scheme used by the company. | Select a type supported for `countryOfRegistration`; see [supported registration-number types](#supported-registration-number-types). |
| `address` | Object | Registered business address. | Object containing the address fields below. |
| `address.street` | String | Street address, including building or unit information where applicable. | Free text. |
| `address.province` | String | State, province, or other first-level administrative area. | Free text. |
| `address.city` | String | City or locality. | Free text. |
| `address.postalCode` | String | Postal or ZIP code for the registered address. | Use the format defined by the address country. |
| `address.country` | String (enum) | Country of the registered address. | One of the supported ISO 3166-1 alpha-2 codes; see [supported countries](#supported-countries-of-registration). |
| `documentIds` | Array of strings | IDs of the company documents returned by the upload API. | Include the IDs for the uploaded `CertificateOfIncorporation` and `ProofOfAddress` documents. |

#### Supported countries of registration

`countryOfRegistration` must be one of the following ISO 3166-1 alpha-2 codes. Use `XX` only when the country is not represented by a listed code, and pair it with `registrationNumberType: "OTHER"`.

| Region | Supported country codes |
|---|---|
| Asia-Pacific | `IN` India, `SG` Singapore, `CN` China, `JP` Japan, `HK` Hong Kong, `ID` Indonesia, `VN` Vietnam, `TH` Thailand, `MY` Malaysia, `PH` Philippines, `KR` South Korea, `AU` Australia, `NZ` New Zealand, `BD` Bangladesh, `PK` Pakistan, `LK` Sri Lanka, `NP` Nepal, `KH` Cambodia, `MM` Myanmar, `BN` Brunei, `LA` Laos, `MN` Mongolia, `TL` Timor-Leste |
| North America, Central America, and Caribbean | `US` United States, `CA` Canada, `MX` Mexico, `BS` Bahamas, `CR` Costa Rica, `DO` Dominican Republic, `GT` Guatemala, `JM` Jamaica, `PA` Panama |
| Europe | `GB` United Kingdom, `DE` Germany, `FR` France, `NL` Netherlands, `AT` Austria, `BE` Belgium, `CH` Switzerland, `DK` Denmark, `ES` Spain, `IE` Ireland, `IT` Italy, `NO` Norway, `PL` Poland, `PT` Portugal, `SE` Sweden |
| South America | `BR` Brazil, `AR` Argentina, `CL` Chile, `CO` Colombia, `PE` Peru, `VE` Venezuela |
| Middle East and Africa | `AE` United Arab Emirates, `SA` Saudi Arabia, `QA` Qatar, `KW` Kuwait, `BH` Bahrain, `OM` Oman, `ZA` South Africa, `NG` Nigeria |
| Other | `XX` Other / unsupported country |

#### Supported registration-number types

Select a `registrationNumberType` for the same country as `countryOfRegistration`. The API validates `registrationNumber` against the selected type's format. Each country appears once in the table. Where a country supports multiple types, the Type, Registration number, and Issuing authority columns list the corresponding values on matching lines, in the same order.

| Country | Type | Registration number | Issuing authority |
|---|---|---|---|
| India (`IN`) | `CIN`<br>`LLPIN`<br>`GSTIN` | Corporate Identification Number<br>Limited Liability Partnership Identification Number<br>Goods and Services Tax Identification Number | Ministry of Corporate Affairs (MCA)<br>Ministry of Corporate Affairs (MCA)<br>GSTN |
| Singapore (`SG`) | `UEN` | Unique Entity Number | ACRA |
| China (`CN`) | `USCC` | Unified Social Credit Code | State Administration for Market Regulation |
| Japan (`JP`) | `HOJIN_BANGO` | Corporate Number | National Tax Agency |
| Hong Kong (`HK`) | `BRN` | Business Registration Number | Inland Revenue Department |
| Indonesia (`ID`) | `NIB` | Nomor Induk Berusaha | OSS / BKPM |
| Vietnam (`VN`) | `ERC` | Enterprise Registration Certificate | Ministry of Planning and Investment |
| Thailand (`TH`) | `CRN_TH`<br>`TIN_TH` | Company Registration Number<br>Tax Identification Number | Department of Business Development (DBD)<br>Revenue Department |
| Malaysia (`MY`) | `ROC`<br>`GST_MY` | Company Registration Number<br>Goods and Services Tax Number | SSM (Companies Commission of Malaysia)<br>Royal Malaysian Customs |
| Philippines (`PH`) | `SEC_REG_NO`<br>`TIN_PH` | SEC Registration Number<br>Taxpayer Identification Number | Securities and Exchange Commission<br>BIR |
| South Korea (`KR`) | `BRN_KR`<br>`CRN_KR` | Business Registration Number<br>Corporate Registration Number | National Tax Service<br>Court Registry |
| Australia (`AU`) | `ABN`<br>`ACN` | Australian Business Number<br>Australian Company Number | Australian Business Register<br>ASIC |
| New Zealand (`NZ`) | `NZBN`<br>`IRD` | New Zealand Business Number<br>Inland Revenue Number | Companies Office<br>Inland Revenue |
| Bangladesh (`BD`) | `BIN`<br>`TIN_BD` | Business Identification Number<br>Taxpayer Identification Number | National Board of Revenue<br>National Board of Revenue |
| Pakistan (`PK`) | `NTN`<br>`STRN`<br>`SECP_REG` | National Tax Number<br>Sales Tax Registration Number<br>SECP Company Registration Number | Federal Board of Revenue<br>Federal Board of Revenue<br>Securities and Exchange Commission of Pakistan |
| Sri Lanka (`LK`) | `BRN_LK` | Business Registration Number | Registrar of Companies |
| Nepal (`NP`) | `PAN_NP`<br>`CRN_NP` | Permanent Account Number<br>Company Registration Number | Inland Revenue Department<br>Office of Company Registrar |
| Cambodia (`KH`) | `TRN_KH` | Taxpayer Registration Number | General Department of Taxation |
| Myanmar (`MM`) | `BRN_MM` | Business Registration Number | Directorate of Investment and Company Administration |
| Brunei (`BN`) | `ROCN` | Registry of Companies Number | Registrar of Companies |
| Laos (`LA`) | `ERN_LA` | Enterprise Registration Number | Ministry of Industry and Commerce |
| Mongolia (`MN`) | `CRN_MN` | Company Registration Number | General Authority for State Registration |
| Timor-Leste (`TL`) | `NIPC_TL` | Business Identification Number | National Directorate of Business Registration |
| United Kingdom (`GB`) | `CRN_UK`<br>`VAT_UK` | Company Registration Number<br>VAT Number | Companies House<br>HMRC |
| Germany (`DE`) | `HRB`<br>`USTID` | Commercial Register Number<br>VAT Identification Number | Handelsregister<br>Federal Central Tax Office |
| France (`FR`) | `SIREN`<br>`SIRET` | SIREN Number<br>SIRET Number | INSEE<br>INSEE |
| Netherlands (`NL`) | `KVK` | Chamber of Commerce Number | Dutch Chamber of Commerce |
| Spain (`ES`) | `NIF_ES` | Numero de Identificacion Fiscal | Agencia Tributaria |
| Italy (`IT`) | `VAT_IT` | Partita IVA | Agenzia delle Entrate |
| Ireland (`IE`) | `CRO_IE` | Company Registration Number | Companies Registration Office |
| Switzerland (`CH`) | `CHE_CH` | Swiss Company UID | Federal Statistical Office |
| Belgium (`BE`) | `CBE_BE` | Enterprise Number | Crossroads Bank for Enterprises |
| Austria (`AT`) | `FN_AT` | Firmenbuch Number | Firmenbuch |
| Sweden (`SE`) | `ORG_SE` | Organisation Number | Bolagsverket |
| Norway (`NO`) | `ORG_NO` | Organisation Number | Bronnoysund Register Centre |
| Denmark (`DK`) | `CVR_DK` | Central Business Register Number | Danish Business Authority |
| Portugal (`PT`) | `NIF_PT` | Numero de Identificacao Fiscal | Autoridade Tributaria |
| Poland (`PL`) | `KRS_PL` | National Court Register Number | Ministry of Justice |
| Brazil (`BR`) | `CNPJ` | Cadastro Nacional da Pessoa Juridica | Receita Federal |
| Argentina (`AR`) | `CUIT_AR` | Clave Unica de Identificacion Tributaria | AFIP |
| Chile (`CL`) | `RUT_CL` | Rol Unico Tributario | Servicio de Impuestos Internos |
| Colombia (`CO`) | `NIT_CO` | Numero de Identificacion Tributaria | DIAN |
| Peru (`PE`) | `RUC_PE` | Registro Unico de Contribuyentes | SUNAT |
| Venezuela (`VE`) | `RIF_VE` | Registro de Informacion Fiscal | SENIAT |
| United Arab Emirates (`AE`) | `TRN` | Tax Registration Number | Federal Tax Authority |
| Saudi Arabia (`SA`) | `CR_SA` | Commercial Registration Number | Ministry of Commerce |
| Qatar (`QA`) | `CR_QA` | Commercial Registration Number | Ministry of Commerce and Industry |
| Kuwait (`KW`) | `CR_KW` | Commercial Registration Number | Ministry of Commerce and Industry |
| Bahrain (`BH`) | `CR_BH` | Commercial Registration Number | Ministry of Industry and Commerce |
| Oman (`OM`) | `CR_OM` | Commercial Registration Number | Ministry of Commerce, Industry and Investment Promotion |
| South Africa (`ZA`) | `CIPC` | Company Registration Number | Companies and Intellectual Property Commission |
| Nigeria (`NG`) | `RCN` | Corporate Affairs Commission Number | Corporate Affairs Commission |
| United States (`US`) | `EIN` | Employer Identification Number | Internal Revenue Service (IRS) |
| Canada (`CA`) | `BN` | Business Number | Canada Revenue Agency |
| Mexico (`MX`) | `RFC` | Registro Federal de Contribuyentes | SAT |
| Bahamas (`BS`) | `TRN_BS` | Taxpayer Registration Number | Department of Inland Revenue |
| Jamaica (`JM`) | `JAMAICA_TRN` | Taxpayer Registration Number | Tax Administration Jamaica |
| Guatemala (`GT`) | `RTN_GT` | Registro Tributario NIT | Superintendencia de Administracion Tributaria |
| Dominican Republic (`DO`) | `RNC_DO` | Registro Nacional de Contribuyentes | Direccion General de Impuestos Internos |
| Costa Rica (`CR`) | `NITE_CR` | Numero de Identificacion Tributaria | Ministerio de Hacienda |
| Panama (`PA`) | `RUC_PA` | Registro Unico de Contribuyente | Direccion General de Ingresos |
| Other / unsupported country (`XX`) | `OTHER` | Other | — |

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
    "registrationNumber": "U12345KA2024PLC123456",
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

#### Company verification status meanings

The company `status` field supports the following values:

| Status | Meaning |
|---|---|
| `Submitted` | Default status when a company is added. KYB verification has not yet started. |
| `InProgress` | KYB verification has started. |
| `Approved` | Company KYB verification completed successfully and was approved by the customer. |
| `Rejected` | Company KYB verification completed and was rejected by the customer. |
| `Completed` | Company KYB verification is finished, regardless of whether the outcome was successful or unsuccessful. |

> `Success` and `Failed` in the compliance response describe the outcome of an individual compliance check. They are not company verification status values.

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
      "registrationNumber": "U12345KA2024PLC123456",
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

Use the `POST /company-executives` endpoint below to add a shareholder or executive using the request body shown. To add or update a representative, use the `PATCH /company-executives` endpoint in [section 4.5](#45-update-a-representative) and include the Power of Attorney `documentId` in `documentIds`.

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
