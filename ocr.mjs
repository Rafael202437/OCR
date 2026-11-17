import fs from 'fs';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';
import { fileURLToPath } from 'url';

/** Isola o número do fundo e lê os dígitos. Devolve {numero, confianca}.
 * O "modo" diz como o número se destaca do fundo (cada monitor tem um estilo):
 *   "claro" (padrão): número claro/creme/branco sobre fundo escuro  -> r,g,b todos ALTOS
 *   "escuro":         número escuro/vinho sobre fundo claro          -> r,g,b todos BAIXOS
 *   "roxo":           número roxo/magenta sobre fundo laranja         -> azul maior que o verde
 *   "laranja":        número laranja sobre caixa clara/creme          -> vermelho ALTO e azul BAIXO
 * Limiares: "claro"/"escuro"/"laranja" usam r,g,b; "roxo" usa limiar.margem (quanto o azul passa do verde). */
export async function lerNumero(worker, pngBuffer, limiar) {
  const L = limiar || {};
  const modo = (L.modo || 'claro').toLowerCase();
  const img = PNG.sync.read(pngBuffer);
  const W = img.width, H = img.height;
  const P = 28;   // margem branca em volta: o Tesseract lê muito melhor com os dígitos longe das bordas
  const out = new PNG({ width: W + 2 * P, height: H + 2 * P });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = out.data[i + 1] = out.data[i + 2] = 255; out.data[i + 3] = 255; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (y * W + x) * 4;
    const r = img.data[si], g = img.data[si + 1], b = img.data[si + 2];
    let ehDigito;
    if (modo === 'escuro') ehDigito = r < (L.r ?? 100) && g < (L.g ?? 100) && b < (L.b ?? 100);
    else if (modo === 'roxo') ehDigito = b > g + (L.margem ?? 20);
    else if (modo === 'laranja') ehDigito = r > (L.r ?? 180) && g < (L.g ?? 190) && b < (L.b ?? 115);
    else ehDigito = r > (L.r ?? 175) && g > (L.g ?? 165) && b > (L.b ?? 110);
    if (ehDigito) { const di = ((y + P) * (W + 2 * P) + (x + P)) * 4; out.data[di] = out.data[di + 1] = out.data[di + 2] = 0; }
  }
  const png = PNG.sync.write(out);
  // Lê em dois modos de segmentação (8 = palavra única, 7 = linha única). A confiança reportada varia
  // conforme a fonte; por isso usamos a leitura de MAIOR confiança. Quando os dois concordam no número,
  // somamos essa certeza (fica com a maior das duas). A validação forte não é esta: é a repetição entre
  // leituras/ciclos (o coletor exige que leituras independentes batam) e a proteção do servidor.
  const a = await reconhecer(worker, png, '8');
  const b = await reconhecer(worker, png, '7');
  if (a.numero != null && a.numero === b.numero) return { numero: a.numero, confianca: Math.max(a.conf, b.conf) };
  const melhor = a.conf >= b.conf ? a : b;
  return { numero: melhor.numero, confianca: melhor.conf };
}

async function reconhecer(worker, png, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(png);
  const digs = (data.text.match(/\d/g) || []).join('');
  return { numero: digs ? parseInt(digs, 10) : null, conf: Math.round(data.confidence) };
}

export async function criarWorker() {
  // Usa o arquivo de idioma LOCAL (pasta lang) quando ele existe — caso do PC, onde a internet pode
  // bloquear o download. Se não existir (ex.: rodando na nuvem do GitHub), deixa o Tesseract baixar
  // sozinho do site dele. fileURLToPath (não .pathname): no Windows o .pathname vira "/C:/...".
  const langFile = fileURLToPath(new URL('./lang/eng.traineddata.gz', import.meta.url));
  let opts = {};
  if (fs.existsSync(langFile)) {
    opts = { langPath: fileURLToPath(new URL('./lang', import.meta.url)), gzip: true, cachePath: fileURLToPath(new URL('./.cache', import.meta.url)) };
  }
  const w = await createWorker('eng', 1, opts);
  await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
  return w;
}
