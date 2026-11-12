// Runs before any test file imports the app.
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/chat_test';
process.env.FIREBASE_PROJECT_ID ??= 'demo-chat-test';
// `npm test` starts the emulator and sets FIRESTORE_EMULATOR_HOST. Refuse to run
// against a real Firebase project, because the tests delete all documents.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Tests need the Firestore emulator. Run `npm test` (it starts the emulator for you).');
}
