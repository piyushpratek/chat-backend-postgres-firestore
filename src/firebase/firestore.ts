import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from '../config/env';

function initApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  // Local emulator: no credentials needed.
  if (env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: env.FIREBASE_PROJECT_ID });
  }

  // Service account given as env vars (easiest on Render/Railway).
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        // .env files store the key on one line with literal "\n"
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }

  // Falls back to GOOGLE_APPLICATION_CREDENTIALS (path to the service-account JSON).
  return initializeApp({ projectId: env.FIREBASE_PROJECT_ID });
}

export const firestore: Firestore = getFirestore(initApp());
firestore.settings({ ignoreUndefinedProperties: true });

/**
 * Firestore layout
 *
 *   chats/{chatId}                         { lastSeq, lastMessage, updatedAt }
 *   chats/{chatId}/messages/{messageId}    { seq, senderId, text, createdAt, editedAt, deletedAt, readBy }
 *   chats/{chatId}/lastSeen/{userId}       { messageId, seq, updatedAt }
 *
 * chatId is the PostgreSQL chat UUID, so both stores share one id.
 */
export const col = {
  chat: (chatId: string) => firestore.collection('chats').doc(chatId),
  messages: (chatId: string) => col.chat(chatId).collection('messages'),
  message: (chatId: string, messageId: string) => col.messages(chatId).doc(messageId),
  lastSeen: (chatId: string) => col.chat(chatId).collection('lastSeen'),
};
