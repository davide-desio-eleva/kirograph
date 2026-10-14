export default function (f: any) {
  f.get('/x', async () => 'legacy');
}
