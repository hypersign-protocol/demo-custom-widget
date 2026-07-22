const express = require('express');
const path = require('path');
const { getCachedAdminTokens, generateKycUserSessionToken, fetchBusinessKycAccessToken } = require('./tokenService')
const { initializeVerificationSession } = require('./idService')
const { registerUserDid } = require('./ssiService')
const { X_ISSUER_VERMETHOD_ID, X_ISSUER_DID, WIDGET_URL } = require('./config')

const app = express();
const PORT = 3007;

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * @openapi
 * /get-required-tokens-and-session-for-a-user
 * @get
 * @description 
 * Orchestrates the full onboarding handshake for a new KYC user. 
 * This endpoint performs the following sequence:
 * 1. Retrieves or refreshes administrative tokens for KYC and SSI services.
 * 2. Initializes a new KYC verification session.
 * 3. Registers a unique DID (Decentralized Identifier) for the user.
 * 4. Generates a scoped User Bearer Auth Token using a DID-signed JWT.
 * * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * * @returns {JSON} 200 - An object containing all necessary tokens, session details, and user DID metadata.
 * @returns {JSON} 400 - An error message if any step in the handshake sequence fails.
 */
app.post('/get-required-tokens-and-session-for-a-user', async (req, res) => {
    try {
        // 1. Extract and Validate input from request body
        const { name, email } = req.body;

        if (!name || !email) {
            return res.status(400).json({
                error: "Missing required fields: 'name' and 'email' are mandatory."
            });
        }

        // 2. Prepare Administrative Access Tokens (using file-based cache)
        const { kycAdminToken, kybAdminToken, ssiAdminToken } = await getCachedAdminTokens();

        // 3. Initialize the KYC Verification Session
        const sessionId = await initializeVerificationSession(kycAdminToken);

        // 4. Register a new User DID
        const userDidMetadata = await registerUserDid(ssiAdminToken);

        // 5. Prepare User Claims using dynamic data from request
        const userData = {
            name: name,             // mandatory
            email: email,           // mandatory
            did: userDidMetadata.did,
        };

        // 6. Generate the final User-specific Bearer Token
        const userBearerToken = await generateKycUserSessionToken(
            userData,
            kycAdminToken,
            ssiAdminToken,
            sessionId
        );

        // 7. Return comprehensive credentials to the client
        res.json({
            kycAdminToken,
            kybAdminToken,
            ssiAdminToken,
            userBearerToken,
            kycUserAccessToken: userBearerToken,
            widgetUrl: WIDGET_URL,
            issuerDid: X_ISSUER_DID,
            issuerVerificationMethodId: X_ISSUER_VERMETHOD_ID,
            sessionId,
            userDid: userDidMetadata.did,
            userVerificationMethodId: userDidMetadata.verificationMethodId
        });

    } catch (error) {
        console.error(`[Onboarding Flow Error]: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Generate a fresh KYC token for a KYB company. The API secret remains on the
// server; tokenService forwards businessId to /oauth as a query parameter.
app.post('/kyb/kyc-access-token', async (req, res) => {
    try {
        const businessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : '';
        if (!businessId) return res.status(400).json({ error: "Missing required field: 'businessId'." });

        const kycAccessToken = await fetchBusinessKycAccessToken(businessId);
        res.json({ kycAccessToken });
    } catch (error) {
        console.error(`[KYB Business Token Error]: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Explicit route for index.html (optional but clear)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// api to get webhook data
app.post('/webhook', (req, res) => {
    console.log(req.body)
    res.status(200).send();
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
