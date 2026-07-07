const env = require('dotenv');
env.config();
// 1. Generate API Secrets
const SSI_API_SECRET = process.env.SSI_API_SECRET;
const KYC_API_SECRET = process.env.KYC_API_SECRET;

const KYC_BASE_URL = process.env.KYC_BASE_URL
const SSI_BASE_URL = process.env.SSI_BASE_URL;

const DEVELOPER_DASHBOARD_SERVICE_BASE_URL = process.env.DEVELOPER_DASHBOARD_SERVICE_BASE_URL;

function normalizeWidgetUrl(value) {
    const normalizedUrl = (value || "https://verify.hypersign.id").trim();

    if (normalizedUrl.startsWith("http://verify.hypersign.id")) {
        return normalizedUrl.replace(/^http:\/\//, "https://");
    }

    return normalizedUrl;
}

const WIDGET_URL = normalizeWidgetUrl(process.env.WIDGET_URL);
// 2. Create Issuer Account
const X_ISSUER_DID = process.env.ISSUER_DID;
const X_ISSUER_VERMETHOD_ID = process.env.ISSUER_VERMETHOD_ID;


module.exports = {
    SSI_API_SECRET,
    KYC_API_SECRET,
    KYC_BASE_URL,
    SSI_BASE_URL,
    DEVELOPER_DASHBOARD_SERVICE_BASE_URL,
    WIDGET_URL,
    X_ISSUER_DID,
    X_ISSUER_VERMETHOD_ID,
}
