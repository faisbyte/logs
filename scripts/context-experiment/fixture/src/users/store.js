/** Users kept in memory; the production store has the same interface. */
export function memoryUsers(list = []) {
  const byEmail = new Map(list.map((u) => [u.email, u]));
  return {
    async findByEmail(email) {
      return byEmail.get(email) ?? null;
    },
    async findById(id) {
      return list.find((u) => u.id === id) ?? null;
    },
  };
}
