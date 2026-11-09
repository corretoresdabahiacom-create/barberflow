import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { firebaseConfig, firebaseConfigured } from "../config/app";

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function getFirebaseAuth(): Auth | null {
  if (!firebaseConfigured) return null;
  if (!app) {
    app = initializeApp({ apiKey: firebaseConfig.apiKey, authDomain: firebaseConfig.authDomain, projectId: firebaseConfig.projectId, appId: firebaseConfig.appId });
    auth = getAuth(app);
  }
  return auth;
}
