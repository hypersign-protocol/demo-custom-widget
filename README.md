# Custom Widget Demo
This project demonstrates how to integrate and customize the [Hypersign](https://hypersign.id) KYC and SSI APIs. It provides a streamlined implementation for identity verification via [Hypersign](https://hypersign.id) KYC APIs.

## 🚀 Getting Started
### Prerequisites
- Node.js: v16.x or higher
- npm: v8.x or higher
- Hypersign Credentials: You must have an account on the [Hypersign Dashboard](https://entity.dashboard.hypersign.id/).

### Setup

Environment Variables Clone the sample environment file and populate it with your secrets from the [Hypersign Dashboard](https://entity.dashboard.hypersign.id/).

```bash
mv .env-sample .env
```

Edit the `.env` file:

```bash
KYC_API_SECRET = your_kyc_secret_here
SSI_API_SECRET = your_ssi_secret_here
```

also add your Issuer details (you can copy Issuer details from the dashboard)

```bash
ISSUER_DID = "your issuer did here"
ISSUER_VERMETHOD_ID = "your issuer ver method id"
```

### Installation Install the necessary dependencies:

```
npm install
```

### Start the development server:

```
npm run start
```

The start command watches the application and `public/` files, and restarts the
server automatically whenever they change. Refresh the browser after a UI-only
change to load the updated page.

## 🛠 Features & Usage
The Custom Widget provides a comprehensive identity verification suite, including:

- **ID Document OCR**: Automatically extracts text and data from government-issued IDs using Optical Character Recognition.
- **Selfie Capture**: A guided UI for users to take high-quality headshots for verification.
- **Face Authentication**: Comparison of the live selfie against the ID document photo to ensure the user is the rightful owner.
- **User Consent**: A built-in legal and privacy layer to capture and log explicit user permission for data processing.
- **Business verification (KYB)**: Visit `/kyb.html` to upload incorporation,
  address, and power-of-attorney documents; submit a company; add multiple
  shareholders or representatives; and retrieve compliance details by entity ID.


## 📖 Documentation
For a deep dive into the technical implementation, API hooks, and advanced configuration, please refer to our detailed guide:

👉 [Detailed Integration Guide](./integration-doc.md)
