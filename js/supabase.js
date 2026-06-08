/**
 * WholesaleLedger – Supabase Auth Wrapper
 * Expects the Supabase UMD bundle to be loaded first via:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://uwdizokkwjrasscrjbqu.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3ZGl6b2trd2pyYXNzY3JqYnF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTk4NTMsImV4cCI6MjA5NjQ5NTg1M30.dAGrWMP8KVBBDvRq82F48YD_e1BgRv1pczv4TFwOVNU";

  if (typeof window.supabase === "undefined" || !window.supabase.createClient) {
    console.error(
      "[WLAuth] Supabase UMD bundle not found. Make sure the CDN script is loaded before supabase.js."
    );
    return;
  }

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /**
   * Get the raw Supabase client instance.
   * @returns {import("@supabase/supabase-js").SupabaseClient}
   */
  function getClient() {
    return client;
  }

  /**
   * Return the current session user, or null if not authenticated.
   * @returns {Promise<object|null>}
   */
  async function getUser() {
    const {
      data: { session },
      error,
    } = await client.auth.getSession();
    if (error || !session) return null;
    return session.user;
  }

  /**
   * Return the current session object, or null.
   * @returns {Promise<object|null>}
   */
  async function getSession() {
    const {
      data: { session },
      error,
    } = await client.auth.getSession();
    if (error) return null;
    return session;
  }

  /**
   * Sign up a new user with email + password.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{data: object, error: object|null}>}
   */
  async function signUp(email, password) {
    return client.auth.signUp({ email, password });
  }

  /**
   * Sign in an existing user with email + password.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{data: object, error: object|null}>}
   */
  async function signIn(email, password) {
    return client.auth.signInWithPassword({ email, password });
  }

  /**
   * Sign the current user out.
   * @returns {Promise<{error: object|null}>}
   */
  async function signOut() {
    return client.auth.signOut();
  }

  /**
   * Register a callback for auth state changes.
   * @param {function} callback – receives (event, session)
   * @returns {{ data: { subscription: object } }}
   */
  function onAuthStateChange(callback) {
    return client.auth.onAuthStateChange(callback);
  }

  /**
   * Quick boolean check for authentication status.
   * @returns {Promise<boolean>}
   */
  async function isAuthenticated() {
    const user = await getUser();
    return user !== null;
  }

  // ---------------------------------------------------------------------------
  // Expose on window
  // ---------------------------------------------------------------------------
  window.WLAuth = {
    getClient,
    getUser,
    getSession,
    signUp,
    signIn,
    signOut,
    onAuthStateChange,
    isAuthenticated,
  };
})();
