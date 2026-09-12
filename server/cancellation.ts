// All runtime requests belong to this app process, never to the Ollama server.
const controllers = new Set<AbortController>();
export function operationSignal(timeout: number) {
  const controller = new AbortController();
  controllers.add(controller);
  return {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
    dispose: () => controllers.delete(controller),
  };
}
export function cancelOperations() {
  for (const controller of controllers) controller.abort();
}
