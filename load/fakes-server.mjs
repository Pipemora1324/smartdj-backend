// NUNCA EJECUTAR CONTRA PRODUCCIÓN. Dobles de Supabase (JWKS), Jamendo e iTunes para la prueba de carga local.
// Reutiliza los de las pruebas de integración con puertos fijos; escribe el token del dueño en /out/tokens.json.
import { writeFileSync } from 'node:fs';
import { startItunes, startJamendo, startSupabase } from '../backend/test/integration/fakes.js';

const supabase = await startSupabase({ port: 4100 });
const jamendo = await startJamendo({ port: 4101 });
const itunes = await startItunes({ port: 4102 });
writeFileSync('/out/tokens.json', JSON.stringify({ owner: supabase.token({ expiresIn: '3h' }) }));
console.log('Dobles listos: JWKS :4100, Jamendo :4101, iTunes :4102');
// Cuántas veces se llamó a cada API "externa": sirve para medir el caché y la deduplicación.
setInterval(() => writeFileSync('/out/fake-calls.json', JSON.stringify({ jamendo: jamendo.state.calls, itunes: itunes.state.calls })), 2000);
