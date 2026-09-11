// Service worker mínimo, sem cache agressivo (já tivemos dor de cabeça com versão presa em
// cache antes — não vamos repetir isso aqui). Existe só para habilitar "Adicionar à tela
// inicial" em modo standalone no Android/Chrome. Toda requisição vai direto pra rede.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
