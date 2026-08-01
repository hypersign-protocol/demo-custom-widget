# Hypersign Aadhaar Verification API Integration Guide

> Version: 1.0  
> Audience: Backend Engineers, Mobile Developers, Web Developers  
> Product: Hypersign Compliant Aadhaar Verification APIs

---

# Overview

The Hypersign Aadhaar Verification APIs enable applications to perform UIDAI-compliant Aadhaar verification through multiple verification methods depending on business requirements.

The APIs support:

- Aadhaar OTP Verification
- Aadhaar Secure QR Verification
- Aadhaar Face Match (Biometric Verification)

These APIs can be combined to build different onboarding journeys depending on the level of identity assurance required.

---

# Supported Verification Flows

![img](/docs/assets/aadhaar-api/6d2d6235-e1bb-4b15-b36a-354afe02bb8b.png)


# Base URL

```
https://api.cavach.hypersign.id
```

---

# Authentication

All APIs require authentication.

Include the following headers with every request.

| Header | Value |
|---------|------|
| Authorization | Bearer YOUR_API_KEY |
| Content-Type | application/json |

Example:

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

---

# API 1 — Generate Aadhaar OTP

Generates an OTP on the mobile number linked with the Aadhaar number.

## Endpoint

```
POST /api/v1/aadhaar/otp/generate
```

---

## Request Headers

| Header | Required |
|---------|-----------|
| Authorization | Yes |
| Content-Type | Yes |

---

## Request Body
```json
{
  "aadhaar_number": "111122223333",
  "reason": "For KYC"
}
```

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `aadhaar_number` | string | Yes | 12-digit Aadhaar number of the user. **For development/sandbox mode, use `111122223333`.** |
| `reason` | string | Yes | Purpose for generating the OTP (for example: `"For KYC"`). This may be used for audit and compliance purposes. |

---

## Successful Response

```json
{
  "success": "true",
  "message": "success",
  "data": {
    "ref_id": "3f4d8a6d-8f4c-4d7d-bbb7-7d7d73d83b44",
    "message": "OTP generated successfully."
  }
}
```
| Field | Type | Description |
|------|------|-------------|
| `success` | string | Indicates whether the request was processed successfully. |
| `message` | string | Overall status of the API response. |
| `data.ref_id` | string | Reference ID for this OTP generation request. This value **must be passed** to the **OTP Verify API** along with the OTP entered by the user. |
| `data.message` | string | Additional message describing the result of the operation. |


---

## Error Response

```json
{
    "success": false,
    "error": {
        "code": "...",
        "message": "..."
    }
}
```

---

# API 2 — Verify Aadhaar OTP

Verifies the OTP entered by the user and returns the verified Aadhaar details obtained from UIDAI.

> **When to use:**  
> Invoke this API after successfully generating an OTP using the **Generate Aadhaar OTP API**.


## Endpoint

```
POST /api/v1/aadhaar/otp/verify
```

---

## Request Body

```json
{
  "ref_id": "3f4d8a6d-8f4c-4d7d-bbb7-7d7d73d83b44",
  "otp": "111111"
}
```
| Field | Type | Required | Description |
|------|------|----------|-------------|
| `ref_id` | string | Yes | Reference ID returned by the **Generate Aadhaar OTP API**. |
| `otp` | string | Yes | 6-digit OTP received on the Aadhaar-linked mobile number. **For sandbox/development mode, use `111111`.** |
 

---

## Successful Response

Example

```json
{
  "success": "true",
  "message": "success",
  "data": {
    "verified": true,
    "aadhaarData": {
      "referenceId": "01*********7022057***79",
      "name": "XYZ",
      "dob": "30-09-1996",
      "gender": "M",
      ...
      ...
      ...,
      "villageTownCity": "Bihar",
      "jpegImage": "<Base64 Encoded Image>"
    }
  }
}
```

| Field | Type | Description |
|------|------|-------------|
| `success` | string | Indicates whether the request was processed successfully. |
| `message` | string | Overall status of the API response. |
| `data.verified` | boolean | Indicates whether the Aadhaar data and digital signature were successfully verified. |
| `data.aadhaarData` | object | Verified Aadhaar details returned after successful verification. |


The response contains verified Aadhaar information returned by UIDAI.

The `photo` field can be directly used with the Face Match API.

---

# API 3 — Verify Aadhaar Secure QR

Verifies the authenticity of an Aadhaar Secure QR Code by validating its digital signature and extracting the Aadhaar details embedded within it.

Unlike a standard QR code scanner, this API performs **cryptographic signature verification** to ensure that the QR code was issued by UIDAI and has not been tampered with.

> **When to use:**  
> Use this API when the user presents a physical or digital Aadhaar card containing a Secure QR Code. This API provides an offline Aadhaar verification mechanism without requiring OTP authentication.

## Endpoint

```
POST /api/v1/aadhaar/qr/verify
```

---

## Request Body

```json
{
  "qrString": "<Aadhaar QR String>"
}
```

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `qrString` | string | Yes | The Aadhaar Secure QR Code content extracted by the client application after scanning the Aadhaar card. The complete QR string should be passed without modification. |


## What Happens Internally

Hypersign

- verifies UIDAI digital signature
- validates QR authenticity
- extracts Aadhaar information
- extracts Aadhaar photograph
- returns verified data

---

## Successful Response

```json
{
  "success": "true",
  "message": "success",
  "data": {
    "verified": true,
    "aadhaarData": {
      "referenceId": "01*********7022057***79",
      "name": "XYZ",
      "dob": "30-09-1996",
      "gender": "M",
      ..
      ...
      ...
      "mobileHash": "xxxxxx1234",
      "villageTownCity": "Bihar",
      "jpegImage": "<Base64 Encoded Image>"
    }
  }
}
```

The extracted `photo` can be used with the Face Match API. 

| Field | Type | Description |
|------|------|-------------|
| `success` | string | Indicates whether the request was processed successfully. |
| `message` | string | Overall status of the API response. |
| `data.verified` | boolean | Indicates whether the Aadhaar Secure QR Code's digital signature was successfully verified. |
| `data.aadhaarData` | object | Verified Aadhaar details extracted from the Secure QR Code. |

> **Note:** The fields within `aadhaarData` are identical to those returned by the **Verify Aadhaar OTP API**. Refer to the **Aadhaar Data** section in the previous API for a complete description of each field.


---

# API 4 — Aadhaar Face Match

Compares a live selfie captured by the user with the photograph obtained from the Aadhaar verification process and returns a biometric similarity score.

The Aadhaar photograph can be obtained from either:

- **Verify Aadhaar OTP API** (`POST /api/v1/aadhaar/otp/verify`)
- **Verify Aadhaar Secure QR API** (`POST /api/v1/aadhaar/qr/verify`)

> **When to use:**  
> Use this API when biometric verification is required in addition to Aadhaar verification. This API helps confirm that the person presenting the Aadhaar document is the legitimate Aadhaar holder.

---

## Endpoint

```
POST /api/v1/aadhaar/face/match
```

---

## Request Body

```json
{
  "face1": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
  "face2": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
}
```

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `face1` | string | Yes | Base64-encoded Aadhaar photograph returned by either the **Verify Aadhaar OTP API** or the **Verify Aadhaar Secure QR API**. The image must include the appropriate Data URI prefix (for example, `data:image/jpeg;base64,`). |
| `face2` | string | Yes | Base64-encoded live selfie captured by the client application. The image must include the appropriate Data URI prefix (for example, `data:image/jpeg;base64,`). |


---

## Successful Response

```json
{
  "success": "true",
  "message": "success",
  "data": {
    "userImageScore": 88.23,
    "verified": true
  }
}
```

| Field | Type | Description |
|------|------|-------------|
| `success` | string | Indicates whether the request was processed successfully. |
| `message` | string | Overall status of the API response. |
| `data.userImageScore` | number | Similarity score between the Aadhaar photograph and the live selfie. Higher values indicate a stronger facial match. |
| `data.verified` | boolean | Indicates whether the similarity score meets the configured verification threshold. |


---
## Aadhaar Data Returned Through API 

| Field | Type | Description |
|------|------|-------------|
| `referenceId` | string | Masked Aadhaar reference identifier. |
| `name` | string | Full name of the Aadhaar holder. |
| `dob` | string | Date of birth. |
| `gender` | string | Gender (`M`, `F`, or `O`). |
| `careOf` | string | Parent, spouse, or guardian name. |
| `house` | string | House or building name/number. |
| `street` | string | Street or road name. |
| `landmark` | string | Nearby landmark. |
| `villageTownCity` | string | Village, town, or city. |
| `postOffice` | string | Post office name. |
| `subDistrict` | string | Sub-district or Taluk. |
| `district` | string | District name. |
| `state` | string | State or Union Territory. |
| `pincode` | string | Postal PIN code. |
| `mobileHash` | string | Masked representation of the Aadhaar-linked mobile number. |
| `jpegImage` | string | Base64-encoded photograph of the Aadhaar holder. This image can be passed directly to the **Face Match API** for biometric verification. |


--- 

# Complete Integration Examples

## OTP + Face Match

```
POST /aadhaar/otp/generate

↓

POST /aadhaar/otp/verify

↓

Receive Aadhaar Photo

↓

Capture Selfie

↓

POST /aadhaar/face/match

↓

Verification Complete
```

---

## QR + Face Match

```
Client scans Aadhaar QR

↓

POST /aadhaar/qr/verify

↓

Receive Aadhaar Photo

↓

Capture Selfie

↓

POST /aadhaar/face/match

↓

Verification Complete
```

---

## OTP Only

```
POST /aadhaar/otp/generate

↓

POST /aadhaar/otp/verify

↓

Verification Complete
```

---

# Common HTTP Status Codes

| Status | Meaning |
|---------|---------|
| 200 | Success |
| 400 | Invalid Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Resource Not Found |
| 422 | Validation Failed |
| 429 | Rate Limit Exceeded |
| 500 | Internal Server Error |

---

# Error Response Format

```json
{
    "success": false,
    "error": {
        "code": "INVALID_OTP",
        "message": "OTP is invalid or expired"
    }
}
```

---

# Best Practices

- Always perform Face Match immediately after successful Aadhaar verification.
- Never cache Aadhaar photographs longer than required for verification.
- Always use HTTPS.
- Validate request payloads before invoking APIs.
- Handle OTP expiry gracefully by allowing users to regenerate OTP.
- Retry only idempotent requests where applicable.
- Store only the information permitted under applicable UIDAI regulations and your organization's compliance policies.

---

# Integration Decision Matrix

| Requirement | OTP | QR | Face Match |
|------------|-----|----|------------|
| Aadhaar verification | ✅ | ✅ | — |
| Verify Aadhaar authenticity | ✅ | ✅ | — |
| Offline Aadhaar verification | ❌ | ✅ | — |
| Mobile number verification | ✅ | ❌ | — |
| Biometric verification | Optional | Optional | ✅ |

---

# Need Help?

For complete request/response schemas, SDKs, and API playground, refer to the Hypersign OpenAPI documentation.