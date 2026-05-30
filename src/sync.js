// ─── Firebase Realtime Database sync ───
// All Firebase access lives here. The rest of the app talks to this module
// through a small interface (init, sign-in/out, push*, and the onData callback)
// and never imports firebase directly.
//
// Data model (one tree, keyed under a fixed root the security rules lock to the
// owner's Google account):
//
//   /vocab
//     /cards/<id>      → the whole card object
//     /practiceDays    → { "YYYY-MM-DD": { device: count } }
//     /deletedCards    → { id: tombstoneTimestamp }
//     /studyTime       → { "YYYY-MM-DD": seconds }
//
// Why per-card slots: each review writes only that card's slot, and Firebase
// orders writes on the SERVER. Two devices can never clobber each other over a
// disagreeing clock — the bug that plagued the Google-Sheets sync.

import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";
import {
  getDatabase,
  ref,
  onValue,
  update,
  remove,
  get,
} from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyD2CvRZ1omoKw9tJN9LpqIlWOwBf0oAW_g",
  // Use the app's OWN hosting domain as the auth domain so the Google sign-in
  // handler is same-origin. iOS Safari/Chrome partition storage across domains
  // (ITP), which broke sign-in when the handler lived on firebaseapp.com.
  authDomain: "vocabulary-portuguese.web.app",
  databaseURL: "https://vocabulary-portuguese-default-rtdb.firebaseio.com",
  projectId: "vocabulary-portuguese",
  storageBucket: "vocabulary-portuguese.firebasestorage.app",
  messagingSenderId: "523001150549",
  appId: "1:523001150549:web:1c9456eabf17e3729528dc",
};

const ROOT = "vocab";

// Reuse an existing app if one's already initialized (avoids duplicate-app
// errors under hot-reload / double imports).
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
// Stay signed in across reloads — sign in once per device.
setPersistence(auth, browserLocalPersistence).catch(() => {});

const provider = new GoogleAuthProvider();

// ─── Auth ───
// Always use a full-page redirect (not a pop-up). Pop-ups are blocked inside
// iOS home-screen apps and cause auth/cancelled-popup-request errors; redirect
// works everywhere — desktop, mobile Safari, and standalone home-screen apps.
export const onAuth = (cb) => onAuthStateChanged(auth, cb);
export const signIn = () => signInWithRedirect(auth, provider);
// Completes a redirect sign-in when the app reloads after returning from Google.
export const completeRedirect = () => getRedirectResult(auth);
export const signOutUser = () => signOut(auth);
export const currentUser = () => auth.currentUser;

// ─── Reads ───
// Subscribe to the whole tree. cb receives a normalized
// { cards: [...], practiceDays, deletedCards, studyTime } object on every change.
export const subscribe = (cb, onError) => {
  const r = ref(db, ROOT);
  return onValue(
    r,
    (snap) => {
      const v = snap.val() || {};
      const cardsMap = v.cards || {};
      cb({
        cards: Object.values(cardsMap),
        practiceDays: v.practiceDays || {},
        deletedCards: v.deletedCards || {},
        studyTime: v.studyTime || {},
      });
    },
    // Fires on permission-denied (rules not set, or wrong account signed in).
    (err) => { if (onError) onError(err); }
  );
};

// One-off read of the whole tree (used to check whether migration is needed).
export const readOnce = async () => {
  const snap = await get(ref(db, ROOT));
  return snap.val();
};

// ─── Writes ───
// Write a single card to its own slot. Granular = no cross-card clobber.
export const pushCard = (card) =>
  update(ref(db, `${ROOT}/cards`), { [card.id]: card });

// Write many cards at once (imports, migration, bulk edits).
export const pushCards = (cards) => {
  const patch = {};
  for (const c of cards) patch[c.id] = c;
  return update(ref(db, `${ROOT}/cards`), patch);
};

export const removeCard = (id) => remove(ref(db, `${ROOT}/cards/${id}`));

export const pushPracticeDays = (practiceDays) =>
  update(ref(db, ROOT), { practiceDays });

export const pushDeleted = (deletedCards) =>
  update(ref(db, ROOT), { deletedCards });

export const pushStudyTime = (studyTime) =>
  update(ref(db, ROOT), { studyTime });

// Full overwrite of the tree — used once, by the migration, to seed everything.
export const seedAll = ({ cards, practiceDays, deletedCards, studyTime }) => {
  const cardsMap = {};
  for (const c of cards) cardsMap[c.id] = c;
  return update(ref(db, ROOT), {
    cards: cardsMap,
    practiceDays: practiceDays || {},
    deletedCards: deletedCards || {},
    studyTime: studyTime || {},
  });
};
