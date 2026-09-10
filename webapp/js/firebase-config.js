// Cole aqui a configuração do seu projeto Firebase
// (Console Firebase > Configurações do projeto > Seus apps > SDK setup and configuration).
// Este arquivo é público (roda no navegador) — isso é normal e seguro para o Firebase:
// quem protege os dados de verdade são as Firestore/Storage Security Rules (firestore.rules,
// storage.rules), não o sigilo destas chaves.
export const firebaseConfig = {
  apiKey: "COLE_AQUI",
  authDomain: "COLE_AQUI.firebaseapp.com",
  projectId: "COLE_AQUI",
  storageBucket: "COLE_AQUI.appspot.com",
  messagingSenderId: "COLE_AQUI",
  appId: "COLE_AQUI",
};

// ID da região onde as Cloud Functions foram publicadas (padrão: us-central1).
export const FUNCTIONS_REGION = "us-central1";
