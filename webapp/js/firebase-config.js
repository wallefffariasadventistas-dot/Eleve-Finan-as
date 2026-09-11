// Cole aqui a configuração do seu projeto Firebase
// (Console Firebase > Configurações do projeto > Seus apps > SDK setup and configuration).
// Este arquivo é público (roda no navegador) — isso é normal e seguro para o Firebase:
// quem protege os dados de verdade são as Firestore/Storage Security Rules (firestore.rules,
// storage.rules), não o sigilo destas chaves.
export const firebaseConfig = {
  apiKey: "AIzaSyB8IxZxdn_VO3HBMsimE4UtajZZ-KO-Hxo",
  authDomain: "eleve-financeiro-novo.firebaseapp.com",
  projectId: "eleve-financeiro-novo",
  storageBucket: "eleve-financeiro-novo.firebasestorage.app",
  messagingSenderId: "553632123558",
  appId: "1:553632123558:web:2ae82d82375b70c2bc0267",
};

// ID da região onde as Cloud Functions foram publicadas (padrão: us-central1).
export const FUNCTIONS_REGION = "us-central1";
