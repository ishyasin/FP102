// ============================================================================
// SHARED SUPABASE CLIENT + EDGE FUNCTION CALLER
// Include this after the Supabase JS CDN script on every page:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
//   <script src="shared/fp10-api.js"></script>
// ============================================================================

// TODO: fill in from Supabase dashboard → Project Settings → API
const SUPABASE_URL = 'https://vcoucpqouicbbcvmssys.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjb3VjcHFvdWljYmJjdm1zc3lzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzYyNTksImV4cCI6MjEwMjIxMjI1OX0.TpnIBd6lQoiMzh8QCdcBuPcTx3lI3V-qBi2jtJHagU4';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Signs in with the app's own User ID + Passcode fields rather than a real
 * email/password. Looks up the real (synthetic) email behind that user_id
 * via the email_for_user_id RPC, then does a normal Supabase password
 * sign-in with it. Throws a generic error on any failure — deliberately
 * doesn't distinguish "no such user ID" from "wrong passcode" from
 * "account suspended/not yet approved", so a login screen can't be used
 * to enumerate valid IDs.
 */
async function signInWithUserId(userId, passcode) {
  const { data: email, error: lookupError } = await supabaseClient
    .rpc('email_for_user_id', { lookup_user_id: userId.trim() });

  if (lookupError || !email) {
    throw new Error('Incorrect User ID or Passcode.');
  }

  const { error: signInError } = await supabaseClient.auth.signInWithPassword({
    email,
    password: passcode,
  });

  if (signInError) {
    throw new Error('Incorrect User ID or Passcode.');
  }

  // The credentials were correct — but active is enforced again here (and
  // again server-side by RLS + every Edge Function) so a suspended or
  // not-yet-approved account gets a clear, honest message instead of a
  // silently empty app.
  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('active')
    .single();

  if (!profile?.active) {
    await supabaseClient.auth.signOut();
    throw new Error('Your account is suspended or awaiting approval. Contact your administrator.');
  }
}

/**
 * Redirects to the login page if there is no active session, or if the
 * account has since been suspended. Call this at the top of every
 * protected page. Returns the session if one exists and is active.
 */
async function requireSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }

  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('active')
    .eq('id', session.user.id)
    .single();

  if (!profile?.active) {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
    return null;
  }

  return session;
}

/**
 * Fetches the logged-in user's own profile: name, role, trust_id.
 * Use this to display "Logged in as ..." instead of a typed name field,
 * and to decide whether to show admin-panel links.
 */
async function getMyProfile() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('user_id, first_name, last_name, role, trust_id, active')
    .eq('id', user.id)
    .single();

  if (!profile) return null;
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.user_id;
  return { ...profile, fullName, isAdmin: profile.role === 'admin' || profile.role === 'superuser', isSuperuser: profile.role === 'superuser' };
}

/**
 * Fetches the logged-in user's trust — name + a signed URL for their logo.
 * Returns null if no trust is assigned (e.g. a superuser isn't scoped to one).
 */
async function getMyTrust() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('trust_id')
    .eq('id', user.id)
    .single();

  if (!profile?.trust_id) return null;

  const { data: trust } = await supabaseClient
    .from('trusts')
    .select('id, name, logo_path')
    .eq('id', profile.trust_id)
    .single();

  if (!trust) return null;

  let logoUrl = null;
  if (trust.logo_path) {
    const { data: signed } = await supabaseClient
      .storage
      .from('trust-logos')
      .createSignedUrl(trust.logo_path, 60 * 60); // 1 hour, plenty for one PDF generation
    logoUrl = signed?.signedUrl ?? null;
  }

  return { id: trust.id, name: trust.name, logoUrl };
}

/**
 * Calls the fp10-logic Edge Function (serial-number logic) with the given
 * action + payload. Throws an Error with a user-facing message on failure.
 */
async function callFp10Logic(action, payload) {
  return callEdgeFunction('fp10-logic', action, payload);
}

/**
 * Calls the admin-users Edge Function (trust/user management — creating
 * logins, approving/suspending). Only succeeds for admin/superuser accounts;
 * the function itself re-checks this server-side regardless of what the
 * frontend shows or hides.
 */
async function callAdminUsers(action, payload) {
  return callEdgeFunction('admin-users', action, payload);
}

async function callEdgeFunction(functionName, action, payload) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('Your session has expired — please log in again.');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Something went wrong processing that request.');
  return body;
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.href = 'login.html';
}
