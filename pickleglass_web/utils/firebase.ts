// Import the functions you need from the SDKs you need
import { initializeApp, getApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
// import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyAc5Y2KvEnPIg28hr9JngFE69nlbXMijAc",
  authDomain: "glass-f347d.firebaseapp.com",
  projectId: "glass-f347d",
  storageBucket: "glass-f347d.firebasestorage.app",
  messagingSenderId: "669754461081",
  appId: "1:669754461081:web:bc251d5944e01ed90f6108",
  measurementId: "G-8C1MN85HN7"
};

// Initialize Firebase
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const firestore = getFirestore(app);
// const analytics = getAnalytics(app);

export { app, auth, firestore }; 