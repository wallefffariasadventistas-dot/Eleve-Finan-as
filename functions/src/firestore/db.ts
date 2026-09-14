import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

initializeApp();

export const db = getFirestore();
export const bucket = getStorage().bucket();

export const collections = {
  expenses: db.collection("despesas"),
  travelReports: db.collection("relatoriosViagem"),
  conversationState: db.collection("estadoConversa"),
  settings: db.collection("configuracoes"),
};
