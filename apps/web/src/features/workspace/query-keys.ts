/** React Query keys shared across features (hub dialog, project workspace) so invalidations stay in step. */
export const listProjectInputsKey = (projectId: string) => ["listProjectInputs", { projectId }] as const;
