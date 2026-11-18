#!/usr/bin/env node
/*
 * Coletor OCR — Contador de Brindes · Optimall
 * Abre o monitor de brindes de cada shopping no Podi, lê o número por OCR e envia ao portal.
 * Roda em qualquer computador com Node 18+ e navegador (NÃO na Hospedagem Hostinger).
 *
 *   node coletor.mjs                 # roda em laço, a cada "intervaloMin"
 *   node coletor.mjs --uma-vez       # lê uma vez e sai
 *   node coletor.mjs --ajustar spjp  # salva a imagem recortada de um contador p/ conferir o recorte
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'playwright';
const { chromium } = pw;
import { criarWorker, lerNumero } from './ocr.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));   // pasta do coletor — as imagens sempre caem aqui
const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
// token e portal podem vir de variáveis de ambiente (ex.: segredo do GitHub Actions), sem escrever no arquivo
const TOKEN = process.env.BRINDES_OCR_TOKEN || cfg.token;
const PORTAL = process.env.BRINDES_PORTAL || cfg.portal;
const BASE = 'https://tv.podiapp.com.br/#/cg/';
const args = process.argv.slice(2);
const umaVez = args.includes('--uma-vez');
const ajustar = args.includes('--ajustar') ? args[args.indexOf('--ajustar') + 1] : null;
const hora = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });   // log sempre no horário de Brasília
const log = (...a) => console.log(hora(), '·', ...a);

// cada contador pode ter o seu recorte/cor; se não tiver, usa o geral do config
const recorteDe = c => (c && c.recorte) || cfg.recorte;
const limiarDe = c => (c && c.limiar) || cfg.limiar;
const contadorPorCodigo = cod => (cfg.contadores || []).find(c => c.codigo === cod);
function clipDe(page, c) {
  const vp = page.viewportSize(), r = recorteDe(c);
  return { x: Math.round(r.x * vp.width), y: Math.round(r.y * vp.height), width: Math.round(r.largura * vp.width), height: Math.round(r.altura * vp.height) };
}
async function abrir(page, cod) {
  log('abrindo', BASE + cod, '...');
  try { await page.goto(BASE + encodeURIComponent(cod), { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  catch (e) { log('aviso ao abrir:', e.message); }
  await page.waitForTimeout(8000);   // o monitor é um app (Flutter) que desenha o número depois de abrir
}

/* Ajuste do recorte: abre UM contador e salva duas imagens (tela inteira e só o número),
 * para conferir se o recorte pega o número. Funciona com qualquer código, mesmo que ainda
 * não esteja no config.json. Sempre diz onde salvou — ou qual foi o erro. */
async function ajustarRecorte(browser, cod) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const c = contadorPorCodigo(cod) || { codigo: cod };
  const pTela = path.join(DIR, 'recorte-' + cod + '-tela.png');
  const pNum = path.join(DIR, 'recorte-' + cod + '.png');
  try {
    await abrir(page, cod);
    await page.screenshot({ path: pTela });
    await page.screenshot({ path: pNum, clip: clipDe(page, c) });
    log('SALVEI as imagens na pasta do coletor:');
    log('  ' + pTela + '  (tela inteira)');
    log('  ' + pNum + '  (so o numero)');
    log('Abra as duas. Se o numero nao estiver inteiro no recorte, ajuste "recorte" no config.json.');
  } catch (e) {
    log('ERRO ao gerar o recorte de "' + cod + '":', e.message);
    log('Se foi tempo esgotado ao abrir, confira a internet e se o codigo "' + cod + '" esta certo (final do link .../#/cg/' + cod + ').');
  } finally {
    await page.close();
  }
}

async function rodar(worker, browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const leituras = [];
  for (const c of cfg.contadores) {
    try {
      // O monitor do Podi ANIMA a contagem ao abrir (o número sobe de 0 até o valor real). Por isso
      // abrimos a página UMA vez e tiramos fotos sem recarregar, até o número PARAR de mudar (duas
      // leituras seguidas iguais = animação terminou). Assim não pegamos um número parcial.
      await abrir(page, c.codigo);
      const tirar = () => page.screenshot({ clip: clipDe(page, c) });
      let r = await lerNumero(worker, await tirar(), limiarDe(c));
      let num = null, conf = 0;
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(2500);
        const r2 = await lerNumero(worker, await tirar(), limiarDe(c));
        if (r2.numero != null && r2.numero === r.numero) { num = r2.numero; conf = Math.max(r.confianca, r2.confianca); break; }
        r = r2;
      }
      // Garantia da leitura: a ESTABILIZAÇÃO (o número parou de mudar entre fotos). A confiança do
      // Tesseract é pouco confiável nessa fonte (às vezes 0% numa leitura certa), então NÃO barramos
      // por ela. Barramos só número com menos dígitos que o esperado (truncado) — e o servidor ainda
      // rejeita quedas/subidas absurdas, que é onde um truncado sempre cai.
      const dig = c.digitos || 0;
      if (num == null) { log(c.nome || c.codigo, '→ número não estabilizou, ignorada'); }
      else if (dig && String(num).length < dig) { log(c.nome || c.codigo, '→ número incompleto (' + num + ', esperado ' + dig + ' dígitos), ignorada'); }
      else { const envc = Math.max(conf, 80); leituras.push({ codigo: c.codigo, quantidade: num, confianca: envc }); log(c.nome || c.codigo, '→', num, (conf ? '(ocr ' + conf + '%)' : '(estável)')); }
    } catch (e) { log(c.nome || c.codigo, '→ erro:', e.message); }
  }
  await page.close();
  if (!leituras.length) return;
  try {
    const res = await fetch(PORTAL.replace(/\/$/, '') + '/api/brindes-ocr.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OCR-Token': TOKEN }, body: JSON.stringify({ leituras }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) log('Portal recusou:', res.status, j.error || ''); else log('Enviado:', (j.resultados || []).map(x => x.codigo + '=' + x.r).join(', '));
  } catch (e) { log('Falha ao enviar ao portal:', e.message); }
}

/* Abre o navegador SEM depender de baixar o Chromium do Playwright (que é o que costuma falhar).
 * Usa, nesta ordem: o que estiver em config.json ("navegador": "chrome" | "edge" | "chromium"),
 * depois o Google Chrome instalado, depois o Microsoft Edge (vem em todo Windows 10/11) e,
 * só por último, o Chromium do Playwright, se tiver sido baixado. */
async function abrirNavegador() {
  const tentativas = [];
  const forcar = (cfg.navegador || '').toLowerCase();
  const porCanal = { chrome: 'chrome', edge: 'msedge', msedge: 'msedge' };
  if (forcar && porCanal[forcar]) tentativas.push({ nome: forcar === 'chrome' ? 'Google Chrome' : 'Microsoft Edge', opts: { channel: porCanal[forcar] } });
  else if (forcar === 'chromium') tentativas.push({ nome: 'Chromium do Playwright', opts: {} });
  // ordem padrão: Chrome instalado → Edge instalado → Chromium baixado
  if (!forcar) {
    tentativas.push({ nome: 'Google Chrome', opts: { channel: 'chrome' } });
    tentativas.push({ nome: 'Microsoft Edge', opts: { channel: 'msedge' } });
    tentativas.push({ nome: 'Chromium do Playwright', opts: {} });
  }
  // caminhos comuns do Chrome/Edge no Windows, caso o canal não resolva sozinho
  const execs = [
    ['Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['Google Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    ['Microsoft Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['Microsoft Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  ];
  for (const t of tentativas) {
    try { const b = await chromium.launch(t.opts); log('Navegador:', t.nome); return b; }
    catch (e) { log('não foi com', t.nome + ':', (e.message || '').split('\n')[0]); }
  }
  for (const [nome, p] of execs) {
    if (!fs.existsSync(p)) continue;
    try { const b = await chromium.launch({ executablePath: p }); log('Navegador:', nome, '(caminho direto)'); return b; }
    catch (e) { log('não foi com', nome, '(caminho direto):', (e.message || '').split('\n')[0]); }
  }
  return null;
}

const browser = await abrirNavegador();
if (!browser) {
  log('ERRO: nao encontrei Google Chrome nem Microsoft Edge nesta maquina.');
  log('Instale o Google Chrome (https://www.google.com/chrome) e rode de novo.');
  log('O Microsoft Edge ja vem no Windows 10/11 e tambem serve.');
  process.exit(1);
}
if (ajustar) {
  // só conferir o recorte: não precisa do OCR nem da lista do config
  await ajustarRecorte(browser, ajustar);
  await browser.close();
  process.exit(0);
}
const worker = await criarWorker();
log('Coletor OCR iniciado ·', cfg.contadores.length, 'contador(es) ·', PORTAL);
await rodar(worker, browser);
if (!umaVez) setInterval(() => rodar(worker, browser).catch(e => log('ciclo:', e.message)), Math.max(5, cfg.intervaloMin || 10) * 60000);
else { await browser.close(); await worker.terminate(); }
