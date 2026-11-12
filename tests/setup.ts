/// <reference types="node" />

// Runs before any test file imports the app.
import 'dotenv/config'; // so TEST_DATABASE_URL can come from .env

process.env.NODE_ENV = 'test';
// Tests always use a demo project on the local emulator, never the real Firebase project.
process.env.FIREBASE_PROJECT_ID = 'demo-chat-test';
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'Set TEST_DATABASE_URL in .env to a SEPARATE, empty database (the tests delete all rows in it).',
  );
}
// `npm test` starts the emulator and sets FIRESTORE_EMULATOR_HOST. Refuse to run
// against a real Firebase project, because the tests delete all documents.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Tests need the Firestore emulator. Run `npm test` (it starts the emulator for you).');
}