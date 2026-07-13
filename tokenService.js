const { KYC_API_SECRET, SSI_API_SECRET, DEVELOPER_DASHBOARD_SERVICE_BASE_URL } = require('./config')
const fs = require('fs').promises;
const path = require('path');
const { requestDidJwtSignature } = require('./ssiService')
const { exchangeJwtForKycAccessToken } = require('./idService')
const CACHE_FILE_PATH = path.join(__dirname, 'admin_tokens_cache.json');
const EXPIRY_BUFFER_MS = 60000; // 1-minute safety buffer

/**
 * Fetches an administrative OAuth access token from the Hypersign Developer Dashboard.
 * * @param {string} apiSecret - The secret key associated with your application.
 * @param {'access_service_kyc' | 'access_service_ssi'} serviceType - The specific service scope being requested.
 * @returns {Promise<string>} - A promise that resolves to the raw access token string.
 * @throws {Error} - Throws an error if the network request fails or the API returns an error structure.
 */
async function fetchAdminAccessToken(apiSecret, serviceType, options = {}) {
    const AUTH_ENDPOINT = "/api/v1/app/oauth";
    const query = new URLSearchParams({ grant_type: serviceType });
    if (options.businessId) query.set('businessId', options.businessId);
    const url = `${DEVELOPER_DASHBOARD_SERVICE_BASE_URL}${AUTH_ENDPOINT}?${query}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-Api-Secret-Key': apiSecret,
                'Accept': 'application/json'
            }
        });

        // Handle HTTP errors (4xx, 5xx)
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to fetch access token [${response.status}]: ${errorBody}`);
        }

        const result = await response.json();

        // Validate that the token exists in the response
        if (!result || !result.access_token) {
            throw new Error("Invalid response format: 'access_token' field is missing.");
        }

        return result.access_token;

    } catch (error) {
        // Re-throw the error so the calling function (like prepareAccessTokens) knows it failed
        console.error(`[Admin Auth Error]: ${error.message}`);
        throw error;
    }
}

// Business-scoped KYC tokens are intentionally not cached: the business ID is
// part of the OAuth grant.
async function fetchBusinessKycAccessToken(businessId) {
    if (!businessId || typeof businessId !== 'string') {
        throw new Error('Missing required business ID.');
    }

    return fetchAdminAccessToken(KYC_API_SECRET, 'access_service_kyc', { businessId });
}


/**
 * Extracts the expiration timestamp from a JWT payload.
 * @param {string} token - The encoded JWT string.
 * @returns {number} Expiration time in milliseconds, or 0 if invalid.
 */
function getJwtExpiry(token) {
    if (!token || typeof token !== 'string') return 0;
    try {
        const [, payloadBase64] = token.split('.');
        const normalizedBase64 = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = Buffer.from(normalizedBase64, 'base64').toString();
        const { exp } = JSON.parse(jsonPayload);

        // JWT 'exp' is in seconds; JS Date.now() is in milliseconds
        return exp ? exp * 1000 : 0;
    } catch (error) {
        console.warn('[JWT Decode Warning]: Could not parse token expiry.');
        return 0;
    }
}

/**
 * Ensures valid administrative tokens are available by checking a local cache 
 * or fetching fresh ones if they are missing or expired.
 * @returns {Promise<{kycAdminToken: string, kybAdminToken: string, ssiAdminToken: string}>}
 */
async function getCachedAdminTokens() {
    let cachedData = null;

    // 1. Attempt to load tokens from the local filesystem
    try {
        const fileContent = await fs.readFile(CACHE_FILE_PATH, 'utf8');
        cachedData = JSON.parse(fileContent);
    } catch (err) {
        // File doesn't exist or is invalid JSON; we proceed to fetch fresh tokens
        console.error(err.message)
    }

    const now = Date.now();

    // 2. Validate existence of all service tokens
    const hasTokens = cachedData?.kycAdminToken && cachedData?.kybAdminToken && cachedData?.ssiAdminToken;

    // 3. Check if tokens are expired (including a safety buffer)
    const isExpired = !hasTokens ||
        getJwtExpiry(cachedData.kycAdminToken) <= (now + EXPIRY_BUFFER_MS) ||
        getJwtExpiry(cachedData.kybAdminToken) <= (now + EXPIRY_BUFFER_MS) ||
        getJwtExpiry(cachedData.ssiAdminToken) <= (now + EXPIRY_BUFFER_MS);

    if (!hasTokens || isExpired) {
        console.log(isExpired ? 'Tokens expired/missing. Fetching fresh admin tokens...' : 'Initializing admin tokens...');

        // 4. Fetch fresh tokens from the Developer Dashboard
        const [kycAdminToken, kybAdminToken, ssiAdminToken] = await Promise.all([
            fetchAdminAccessToken(KYC_API_SECRET, 'access_service_kyc'),
            fetchAdminAccessToken(KYC_API_SECRET, 'access_service_kyb'),
            fetchAdminAccessToken(SSI_API_SECRET, 'access_service_ssi')
        ]);

        const freshTokens = { kycAdminToken, kybAdminToken, ssiAdminToken };

        // 5. Update the cache file
        try {
            await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(freshTokens, null, 2));
        } catch (writeError) {
            console.error('[Cache Error]: Failed to save tokens to disk.', writeError.message);
        }

        return freshTokens;
    }

    console.log('Using valid administrative tokens from cache.');
    return cachedData;
}

/**
 * @description Orchestrates the generation of a KYC Service User Access Token.
 * This involves a two-step handshake:
 * 1. Generating a DID-based JWT acting as a Proof-of-Identity (via SSI Service).
 * 2. Exchanging that JWT for a session-specific User Access Token (via KYC Service).
 * * @param {Object} claims - The user attributes to be included in the DID JWT.
 * @param {string} kycAdminToken - The administrative access token for the KYC service.
 * @param {string} ssiAdminToken - The administrative access token for the SSI service.
 * @param {string} sessionId - Unique session identifier for the verification process.
 * @returns {Promise<string>} The final kycServiceUserAccessToken.
 */
async function generateKycUserSessionToken(claims, kycAdminToken, ssiAdminToken, sessionId) {
    try {
        // STEP 1: Request a DID-signed JWT from the SSI Service
        const didJwt = await requestDidJwtSignature(claims, ssiAdminToken);

        // STEP 2: Exchange the DID JWT for the final KYC User Access Token
        const kycUserAccessToken = await exchangeJwtForKycAccessToken(
            didJwt,
            kycAdminToken,
            ssiAdminToken,
            sessionId
        );

        return kycUserAccessToken;
    } catch (error) {
        console.error(`[Token Generation Error]: ${error.message}`);
        throw error;
    }
}


module.exports = {
    getCachedAdminTokens,
    generateKycUserSessionToken,
    fetchBusinessKycAccessToken
}
