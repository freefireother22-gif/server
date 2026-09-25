'use strict';

const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');

let supabaseClient;

function getSupabase() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  supabaseClient = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  return supabaseClient;
}

function readFirebaseServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    try {
      const jsonText = raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf8');
      const parsed = JSON.parse(jsonText);
      if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      return parsed;
    } catch (error) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is invalid: ${error.message}`);
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  const serviceAccount = readFirebaseServiceAccount();
  if (!serviceAccount) {
    throw new Error(
      'Firebase Admin is not configured. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.'
    );
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

async function verifyFirebaseBearer(authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(authorization || '');
  if (!match) {
    const error = new Error('Missing Firebase Bearer token');
    error.statusCode = 401;
    throw error;
  }

  try {
    return await getFirebaseAdmin().auth().verifyIdToken(match[1], true);
  } catch (cause) {
    const error = new Error('Invalid or expired Firebase token');
    error.statusCode = 401;
    error.cause = cause;
    throw error;
  }
}

async function platformHealth() {
  const result = {
    supabaseConfigured: Boolean(
      process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
    ),
    firebaseAdminConfigured: Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
    ),
    databaseReachable: false
  };

  if (result.supabaseConfigured) {
    try {
      const { error } = await getSupabase()
        .from('users')
        .select('id', { count: 'exact', head: true });
      result.databaseReachable = !error;
      if (error) result.databaseError = error.message;
    } catch (error) {
      result.databaseError = error.message;
    }
  }
  return result;
}

module.exports = {
  getSupabase,
  getFirebaseAdmin,
  verifyFirebaseBearer,
  platformHealth
};
