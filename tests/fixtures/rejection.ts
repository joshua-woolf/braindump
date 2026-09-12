// Bun's rejection matcher types are synchronous; capture the awaited error so
// strict promise lint still checks every asynchronous failure assertion.
export async function rejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the operation to reject, but it succeeded.");
}
