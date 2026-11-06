import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadTasks, grade, verifierFor } from '../src/eval.mjs';

const all = loadTasks(resolve('evals', 'tasks-dificeis.json'));
const byId = Object.fromEntries(all.map((t) => [t.id, t]));
const fence = (code) => '```js\n' + code + '\n```';

// Soluções de referência: provam que os valores esperados estão certos.
const REF = {
  'hard-excel-coluna': `function solve(n){let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}`,
  'hard-arredondar': `function solve(x){const s=Math.sign(x)||1;const a=Math.abs(x);return s*Number(Math.round(Number(a+'e2'))+'e-2')}`,
  'hard-csv-linha': `function solve(l){const out=[];let cur='',q=false;for(let i=0;i<l.length;i++){const c=l[i];if(q){if(c==='"'){if(l[i+1]==='"'){cur+='"';i++}else q=false}else cur+=c}else if(c==='"')q=true;else if(c===','){out.push(cur);cur=''}else cur+=c}out.push(cur);return out}`,
  'hard-semver': `function solve(a,b){const p=v=>{const [core,pre]=v.split(/-(.*)/s);return {c:core.split('.').map(Number),p:pre?pre.split('.'):[]}};const A=p(a),B=p(b);for(let i=0;i<3;i++){if(A.c[i]!==B.c[i])return A.c[i]<B.c[i]?-1:1}if(!A.p.length&&!B.p.length)return 0;if(!A.p.length)return 1;if(!B.p.length)return -1;for(let i=0;i<Math.max(A.p.length,B.p.length);i++){const x=A.p[i],y=B.p[i];if(x===undefined)return -1;if(y===undefined)return 1;if(x===y)continue;const nx=/^\\d+$/.test(x),ny=/^\\d+$/.test(y);if(nx&&ny)return Number(x)<Number(y)?-1:1;if(nx)return -1;if(ny)return 1;return x<y?-1:1}return 0}`,
  'hard-expressao': `function solve(e){let i=0;const s=e.replace(/\\s+/g,'');const num=()=>{let j=i;while(i<s.length&&/[0-9]/.test(s[i]))i++;return Number(s.slice(j,i))};const fac=()=>{if(s[i]==='-'){i++;return -fac()}if(s[i]==='+'){i++;return fac()}if(s[i]==='('){i++;const v=add();i++;return v}return num()};const mul=()=>{let v=fac();while(s[i]==='*'||s[i]==='/'){const o=s[i++];const r=fac();v=o==='*'?v*r:v/r}return v};const add=()=>{let v=mul();while(s[i]==='+'||s[i]==='-'){const o=s[i++];const r=mul();v=o==='+'?v+r:v-r}return v};return add()}`,
  'hard-intervalos': `function solve(a){const s=[...a].sort((x,y)=>x[0]-y[0]);const r=[];for(const [x,y] of s){if(r.length&&x<=r.at(-1)[1])r.at(-1)[1]=Math.max(r.at(-1)[1],y);else r.push([x,y])}return r}`,
  'hard-atoi': `function solve(s){const m=s.match(/^\\s*([+-]?)(\\d+)/);if(!m)return 0;let v=Number(m[2])*(m[1]==='-'?-1:1);return Math.max(-2147483648,Math.min(2147483647,v))}`,
  'hard-popcount': `function solve(n){let c=0,x=n>>>0;while(x){c+=x&1;x>>>=1}return c}`,
  'hard-ordem-natural': `function solve(l){const tk=s=>s.match(/\\d+|\\D+/g)||[];const cmp=(a,b)=>{const A=tk(a),B=tk(b);for(let i=0;i<Math.min(A.length,B.length);i++){const x=A[i],y=B[i];const nx=/^\\d/.test(x),ny=/^\\d/.test(y);if(nx&&ny){if(Number(x)!==Number(y))return Number(x)-Number(y)}else if(x!==y)return x<y?-1:1}return A.length-B.length};return [...l].sort(cmp)}`,
  'hard-dia-semana': `function solve(d){return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(d+'T00:00:00Z').getUTCDay()]}`,
  'hard-levenshtein': `function solve(a,b){const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);for(let j=1;j<=b.length;j++)d[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[a.length][b.length]}`,
  'hard-topo-lexico': `function solve(n,ar){const g=Array.from({length:n},()=>[]),ind=Array(n).fill(0);for(const [a,b] of ar){g[a].push(b);ind[b]++}const av=[];for(let i=0;i<n;i++)if(!ind[i])av.push(i);const out=[];while(av.length){av.sort((x,y)=>x-y);const v=av.shift();out.push(v);for(const w of g[v])if(--ind[w]===0)av.push(w)}return out.length===n?out:null}`,
  'hard-lucro-2': `function solve(p){let b1=-Infinity,s1=0,b2=-Infinity,s2=0;for(const x of p){b1=Math.max(b1,-x);s1=Math.max(s1,b1+x);b2=Math.max(b2,s1-x);s2=Math.max(s2,b2+x)}return s2}`,
  'hard-inverter-grafemas': `function solve(s){return [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(s)].map(x=>x.segment).reverse().join('')}`,
};

const REF_TEXT = {
  'hard-qa-strawberry': '3',
  'hard-qa-decimal': '9.9',
  'hard-qa-sort-js': '[1, 10, 3]',
  'hard-qa-bola': '5',
  'hard-qa-maquinas': '5',
  'hard-qa-coercao': "'24'",
  'hard-qa-round-py': '2',
  'hard-qa-floordiv': '-4',
  'hard-qa-parseint': '5',
  'hard-qa-sextas-13': '3',
  'hard-qa-fev-1900': '28',
  'hard-review-sort-numeros': 'sort() sem comparador ordena como strings: use (a, b) => a - b.',
  'hard-review-var-closure': 'var tem escopo de função: imprime 3 3 3. Use let.',
  'hard-review-map-parseint': 'map passa o índice como segundo argumento (radix) do parseInt: [10, NaN, 2].',
  'hard-review-remove-iterando': 'Remover da lista durante a iteração pula elementos; itere sobre uma cópia.',
  'hard-review-async-foreach': 'forEach não espera as promises; use for...of com await ou Promise.all.',
  'hard-review-mes-date': 'O mês começa em 0: 12 vira janeiro de 2027. Use 11.',
  'hard-review-sql-null': 'Comparar com = NULL nunca é verdadeiro; use IS NULL.',
  'hard-review-regex-global': 'Com a flag g, test() guarda lastIndex e a segunda chamada começa do fim.',
};

// Soluções ingênuas: cada uma cai na armadilha da tarefa e precisa reprovar.
const NAIVE = {
  'hard-excel-coluna': `function solve(n){let s='';while(n>0){s=String.fromCharCode(64+n%26)+s;n=Math.floor(n/26)}return s}`,
  'hard-arredondar': `function solve(x){return Math.round(x*100)/100}`,
  'hard-dia-semana': `function solve(d){return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(d).getDay()]}`,
  'hard-inverter-grafemas': `function solve(s){return [...s].reverse().join('')}`,
  'hard-expressao': `function solve(e){return eval(e)}`,
  'hard-popcount': `function solve(n){return n.toString(2).split('').filter(c=>c==='1').length}`,
  'hard-atoi': `function solve(s){return parseInt(s)||0}`,
};

test('conjunto difícil: ids únicos, três tipos, referência para todas', () => {
  assert.equal(new Set(all.map((t) => t.id)).size, all.length);
  assert.ok(all.length >= 30);
  for (const t of all) assert.ok(t.kind === 'code' ? REF[t.id] : REF_TEXT[t.id], `sem referência: ${t.id}`);
});

test('conjunto difícil: referências passam', () => {
  for (const [id, code] of Object.entries(REF)) {
    const r = grade(byId[id], fence(code));
    assert.equal(r.pass, true, `${id}: ${r.detail}`);
  }
  for (const [id, text] of Object.entries(REF_TEXT)) {
    const r = grade(byId[id], text);
    assert.equal(r.pass, true, `${id}: ${r.detail}`);
  }
});

test('conjunto difícil: soluções ingênuas caem na armadilha', () => {
  for (const [id, code] of Object.entries(NAIVE)) {
    assert.equal(grade(byId[id], fence(code)).pass, false, `${id} deveria reprovar`);
  }
  assert.match(grade(byId['hard-expressao'], fence(NAIVE['hard-expressao'])).detail, /forbidden/);
});

test('conjunto difícil: respostas-pegadinha reprovam', () => {
  assert.equal(grade(byId['hard-qa-decimal'], '9.11').pass, false);
  assert.equal(grade(byId['hard-qa-bola'], '10 centavos').pass, false);
  assert.equal(grade(byId['hard-qa-maquinas'], '100').pass, false);
  assert.equal(grade(byId['hard-qa-round-py'], '3').pass, false);
  assert.equal(grade(byId['hard-qa-floordiv'], '-3').pass, false);
  assert.equal(grade(byId['hard-qa-floordiv'], '-3.5 vira -4').pass, true);
  assert.equal(grade(byId['hard-qa-fev-1900'], '29').pass, false);
  assert.equal(grade(byId['hard-qa-sort-js'], '[1, 3, 10]').pass, false);
});

test('testes ocultos pegam o que os públicos deixam passar', () => {
  // Públicos do atoi: '42', '   -42', '4193 with words', 'words 987' → a ingênua passa...
  const atoi = verifierFor(byId['hard-atoi']);
  assert.equal(atoi(fence(NAIVE['hard-atoi'])).pass, true);
  // ...e reprova na nota, por causa dos limites de 32 bits.
  assert.equal(grade(byId['hard-atoi'], fence(NAIVE['hard-atoi'])).pass, false);
});

test('sandbox: código do agente não vê variáveis de ambiente do processo', () => {
  process.env.TESSERA_SEGREDO_TESTE = 'x';
  try {
    const t = { kind: 'code', tests: [[[], true]] };
    assert.equal(grade(t, fence('function solve(){return process.env.TESSERA_SEGREDO_TESTE===undefined}')).pass, true);
  } finally { delete process.env.TESSERA_SEGREDO_TESTE; }
});
