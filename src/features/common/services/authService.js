const { onAuthStateChanged, signInWithCustomToken: firebaseSignInWithCustomToken, signOut: firebaseSignOut } = require('firebase/auth');
const { BrowserWindow, shell } = require('electron');
const { getFirebaseAuth } = require('./firebaseClient');
const fetch = require('node-fetch');
const encryptionService = require('./encryptionService');
const migrationService = require('./migrationService');
const sessionRepository = require('../repositories/session');
const permissionService = require('./permissionService');

function isFirebaseEnabledFromEnv() {
    const authMode = (process.env.PICKLE_AUTH_MODE || process.env.pickleglass_AUTH_MODE || '').trim().toLowerCase();
    if (authMode) {
        return authMode === 'firebase' || authMode === 'cloud';
    }

    const enabled = (process.env.PICKLE_ENABLE_FIREBASE || process.env.pickleglass_ENABLE_FIREBASE || '').trim().toLowerCase();
    return enabled === '1' || enabled === 'true' || enabled === 'yes' || enabled === 'on';
}

async function getVirtualKeyByEmail(email, idToken) {
    if (!idToken) {
        throw new Error('Firebase ID token is required for virtual key request');
    }

    const endpoint = process.env.PICKLE_VIRTUAL_KEY_ENDPOINT;
    if (!endpoint) {
        throw new Error('Virtual key endpoint is not configured (set PICKLE_VIRTUAL_KEY_ENDPOINT)');
    }

    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
        redirect: 'follow',
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        console.error('[VK] API request failed:', json.message || 'Unknown error');
        throw new Error(json.message || `HTTP ${resp.status}: Virtual key request failed`);
    }

    const vKey = json?.data?.virtualKey || json?.data?.virtual_key || json?.data?.newVKey?.slug;

    if (!vKey) throw new Error('virtual key missing in response');
    return vKey;
}

class AuthService {
    constructor() {
        this.currentUserId = 'default_user';
        this.currentUserMode = 'local'; // 'local' or 'firebase'
        this.currentUser = null;
        this.isInitialized = false;
        this.firebaseEnabled = isFirebaseEnabledFromEnv();

        // This ensures the key is ready before any login/logout state change.
        this.initializationPromise = null;

        sessionRepository.setAuthService(this);
    }

    isFirebaseEnabled() {
        return this.firebaseEnabled;
    }

    async _initializeLocalOnly() {
        console.log('[AuthService] Firebase auth disabled. Using local-only mode.');
        this.currentUser = null;
        this.currentUserId = 'default_user';
        this.currentUserMode = 'local';

        await sessionRepository.endAllActiveSessions();
        encryptionService.resetSessionKey();

        if (global.modelStateService) {
            try {
                await global.modelStateService.setFirebaseVirtualKey(null);
            } catch (error) {
                console.warn('[AuthService] Failed to clear Firebase virtual key for local-only mode:', error.message);
            }
        }

        this.broadcastUserState();
        this.isInitialized = true;
        console.log('[AuthService] Initialized in local-only mode.');
    }

    initialize() {
        if (this.isInitialized) return this.initializationPromise;
        if (this.initializationPromise) return this.initializationPromise;

        if (!this.firebaseEnabled) {
            this.initializationPromise = this._initializeLocalOnly();
            return this.initializationPromise;
        }

        this.initializationPromise = new Promise((resolve) => {
            const auth = getFirebaseAuth();
            onAuthStateChanged(auth, async (user) => {
                const previousUser = this.currentUser;

                if (user) {
                    // User signed IN
                    console.log(`[AuthService] Firebase user signed in:`, user.uid);
                    this.currentUser = user;
                    this.currentUserId = user.uid;
                    this.currentUserMode = 'firebase';

                    // Clean up any zombie sessions from a previous run for this user.
                    await sessionRepository.endAllActiveSessions();

                    // ** Initialize encryption key for the logged-in user if permissions are already granted **
                    if (process.platform === 'darwin' && !(await permissionService.checkKeychainCompleted(this.currentUserId))) {
                        console.warn('[AuthService] Keychain permission not yet completed for this user. Deferring key initialization.');
                    } else {
                        await encryptionService.initializeKey(user.uid);
                    }

                    // ** Check for and run data migration for the user **
                    // No 'await' here, so it runs in the background without blocking startup.
                    migrationService.checkAndRunMigration(user);

                    if (process.env.PICKLE_VIRTUAL_KEY_ENDPOINT) {
                        try {
                            const idToken = await user.getIdToken(true);
                            const virtualKey = await getVirtualKeyByEmail(user.email, idToken);

                            if (global.modelStateService) {
                                await global.modelStateService.setFirebaseVirtualKey(virtualKey);
                            }
                            console.log(`[AuthService] Virtual key for ${user.email} has been processed and state updated.`);
                        } catch (error) {
                            console.error('[AuthService] Failed to fetch or save virtual key:', error);
                        }
                    } else {
                        if (global.modelStateService) {
                            try {
                                await global.modelStateService.setFirebaseVirtualKey(null);
                            } catch (error) {
                                console.warn('[AuthService] Failed to clear virtual key:', error.message);
                            }
                        }
                        console.log('[AuthService] Virtual key flow disabled (no PICKLE_VIRTUAL_KEY_ENDPOINT); user signs in with their own API keys.');
                    }

                } else {
                    // User signed OUT
                    console.log(`[AuthService] No Firebase user.`);
                    if (previousUser) {
                        console.log(`[AuthService] Clearing API key for logged-out user: ${previousUser.uid}`);
                        if (global.modelStateService) {
                            // The model state service now writes directly to the DB.
                            await global.modelStateService.setFirebaseVirtualKey(null);
                        }
                    }
                    this.currentUser = null;
                    this.currentUserId = 'default_user';
                    this.currentUserMode = 'local';

                    // End active sessions for the local/default user as well.
                    await sessionRepository.endAllActiveSessions();

                    encryptionService.resetSessionKey();
                }
                this.broadcastUserState();
                
                if (!this.isInitialized) {
                    this.isInitialized = true;
                    console.log('[AuthService] Initialized and resolved initialization promise.');
                    resolve();
                }
            });
        });

        return this.initializationPromise;
    }

    async startFirebaseAuthFlow() {
        if (!this.firebaseEnabled) {
            console.log('[AuthService] Firebase auth flow requested, but local-only mode is active.');
            return { success: false, error: 'Firebase auth is disabled. Use personal API keys in local mode.' };
        }

        try {
            const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
            const authUrl = `${webUrl}/login?mode=electron`;
            console.log(`[AuthService] Opening Firebase auth URL in browser: ${authUrl}`);
            await shell.openExternal(authUrl);
            return { success: true };
        } catch (error) {
            console.error('[AuthService] Failed to open Firebase auth URL:', error);
            return { success: false, error: error.message };
        }
    }

    async signInWithCustomToken(token) {
        if (!this.firebaseEnabled) {
            console.log('[AuthService] Ignoring Firebase custom token because local-only mode is active.');
            return { success: false, error: 'Firebase auth is disabled.' };
        }

        const auth = getFirebaseAuth();
        try {
            const userCredential = await firebaseSignInWithCustomToken(auth, token);
            console.log(`[AuthService] Successfully signed in with custom token for user:`, userCredential.user.uid);
            // onAuthStateChanged will handle the state update and broadcast
        } catch (error) {
            console.error('[AuthService] Error signing in with custom token:', error);
            throw error; // Re-throw to be handled by the caller
        }
    }

    async signOut() {
        if (!this.firebaseEnabled) {
            await sessionRepository.endAllActiveSessions();
            this.currentUser = null;
            this.currentUserId = 'default_user';
            this.currentUserMode = 'local';
            encryptionService.resetSessionKey();
            this.broadcastUserState();
            console.log('[AuthService] Local-only sign-out reset completed.');
            return { success: true };
        }

        const auth = getFirebaseAuth();
        try {
            // End all active sessions for the current user BEFORE signing out.
            await sessionRepository.endAllActiveSessions();

            await firebaseSignOut(auth);
            console.log('[AuthService] User sign-out initiated successfully.');
            // onAuthStateChanged will handle the state update and broadcast,
            // which will also re-evaluate the API key status.
        } catch (error) {
            console.error('[AuthService] Error signing out:', error);
        }
    }
    
    broadcastUserState() {
        const userState = this.getCurrentUser();
        console.log('[AuthService] Broadcasting user state change:', userState);
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send('user-state-changed', userState);
            }
        });
    }

    getCurrentUserId() {
        return this.currentUserId;
    }

    getCurrentUser() {
        const isLoggedIn = !!(this.currentUserMode === 'firebase' && this.currentUser);

        if (isLoggedIn) {
            return {
                uid: this.currentUser.uid,
                email: this.currentUser.email,
                displayName: this.currentUser.displayName,
                mode: 'firebase',
                isLoggedIn: true,
                firebaseEnabled: this.firebaseEnabled,
                //////// before_modelStateService ////////
                // hasApiKey: this.hasApiKey // Always true for firebase users, but good practice
                //////// before_modelStateService ////////
            };
        }
        return {
            uid: this.currentUserId, // returns 'default_user'
            email: 'contact@pickle.com',
            displayName: 'Default User',
            mode: 'local',
            isLoggedIn: false,
            firebaseEnabled: this.firebaseEnabled,
            //////// before_modelStateService ////////
            // hasApiKey: this.hasApiKey
            //////// before_modelStateService ////////
        };
    }
}

const authService = new AuthService();
module.exports = authService; 
