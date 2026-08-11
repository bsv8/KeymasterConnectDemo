export async function regeneratePublisherKeyFlow(input: {
  sessionId: string;
  logout: () => Promise<unknown>;
  replaceKey: () => Promise<void> | void;
  reset: () => void;
}): Promise<void> {
  if (input.sessionId) {
    await input.logout();
  }
  await input.replaceKey();
  input.reset();
}
