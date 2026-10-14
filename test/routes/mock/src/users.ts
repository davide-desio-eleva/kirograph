export async function usersRoutes(f: any) {
  f.get('/:id', async (req: any) => req.params.id);
  f.post('/', async () => 'created');
}
