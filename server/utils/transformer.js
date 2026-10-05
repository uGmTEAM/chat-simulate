// Lightweight Transformer (JS, CPU-friendly)
// Char-level, 2-layer, 64-dim embed, 128-dim hidden, 2 heads
// Teacher-forcing training + greedy generation

const fs = require('fs');
const path = require('path');

const EMBED_DIM = 64;
const HIDDEN_DIM = 128;
const NUM_HEADS = 2;
const HEAD_DIM = EMBED_DIM / NUM_HEADS;
const NUM_LAYERS = 2;
const MAX_SEQ_LEN = 32;
const CLIP = 5.0;

// ===== 矩阵工具 =====
function zeros(r, c) { return Array.from({ length: r }, () => new Float64Array(c)); }
function randn(r, c, s) { const m = zeros(r, c); for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) m[i][j] = (Math.random() * 2 - 1) * s; return m; }
function matMul(A, B) {
  const m = A.length, n = B[0].length, k = B.length;
  const C = zeros(m, n);
  for (let i = 0; i < m; i++) for (let p = 0; p < k; p++) {
    const a = A[i][p]; if (!a) continue;
    for (let j = 0; j < n; j++) C[i][j] += a * B[p][j];
  }
  return C;
}
function softmax(v) {
  let mx = -Infinity; for (let i = 0; i < v.length; i++) if (v[i] > mx) mx = v[i];
  let s = 0, e = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) { e[i] = Math.exp(Math.min(v[i] - mx, 50)); s += e[i]; }
  for (let i = 0; i < v.length; i++) e[i] /= s;
  return e;
}
function gelu(x) { return x * (0.5 + 0.5 * Math.tanh(0.797885 * (x + 0.044715 * x * x * x))); }
function gelu_d(x) {
  const gx = 0.797885 * (x + 0.044715 * x * x * x);
  const tg = Math.tanh(gx);
  return 0.5 + 0.5 * tg + x * (0.5 * (1 - tg * tg)) * 0.797885 * (1 + 3 * 0.044715 * x * x);
}
function lnNorm(x, g, b) {
  const n = x.length, mu = x.reduce((a, v) => a + v, 0) / n;
  let vr = 0; for (let i = 0; i < n; i++) { const d = x[i] - mu; vr += d * d; }
  vr = Math.sqrt(vr / n + 1e-8);
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = g[i] * (x[i] - mu) / vr + b[i];
  return o;
}
function clip(v, limit) {
  if (!isFinite(v)) return 0;
  return Math.max(-limit, Math.min(limit, v));
}
function vecAdd(a, b) { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + b[i]; return o; }
function vecSub(a, b) { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; }
function scaleVec(v, s) { const o = new Float64Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] * s; return o; }
function copyVec(v) { return new Float64Array(v); }

// ===== Transformer =====
class Transformer {
  constructor(vocabSize) {
    this.vocabSize = vocabSize || 3000;
    this.charToId = {};
    this.idToChar = {};
    this._buildVocab();
    const s = 0.02;
    this.W_emb   = randn(this.vocabSize, EMBED_DIM, s);
    this.W_q     = randn(EMBED_DIM, EMBED_DIM, s);
    this.W_k     = randn(EMBED_DIM, EMBED_DIM, s);
    this.W_v     = randn(EMBED_DIM, EMBED_DIM, s);
    this.W_o     = randn(EMBED_DIM, EMBED_DIM, s);
    this.W_ff1   = randn(EMBED_DIM, HIDDEN_DIM, s);
    this.W_ff2   = randn(HIDDEN_DIM, EMBED_DIM, s);
    this.b_ff1   = new Float64Array(HIDDEN_DIM);
    this.b_ff2   = new Float64Array(EMBED_DIM);
    this.ln1_g   = new Float64Array(EMBED_DIM).fill(1);
    this.ln1_b   = new Float64Array(EMBED_DIM);
    this.ln2_g   = new Float64Array(EMBED_DIM).fill(1);
    this.ln2_b   = new Float64Array(EMBED_DIM);
    this.W_out   = randn(EMBED_DIM, this.vocabSize, s / 10);
    this.pos_enc = randn(MAX_SEQ_LEN, EMBED_DIM, 0.01);
  }

  _buildVocab() {
    // 常用汉字（扩展版，覆盖日常交流）
    const HAN = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行法学民得经十三之进着等部度家电力里水化高自二理起小物现实加量都两体机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心你明看原又么利比或质气第向道命此变条没结解问意建月公无系军很情最代但坚什居治死己节怎车非吧此您叫美助手客再见次今真错啊哈嗯白呀好呢吗哦啦嗨喂嗯啦咯嘿哇哼呃唉嗳呀嘛哟不没很都要会去来能做说看想知道给用让把被从向对和跟比还又也而但或因为所以如果虽然但是然后而且或者以及可是不过就是还是只有只是应该可以可能必须一定需要能够会要想要得地着了过';
    const punctArr = [
      '，','。','！','？','、','；','：','（','）','《》',
      '…','—','～','·','？','!',',','.',';',':',
      '(',')','[',']','{','}','<','>','/','\\','|',' ','.','_','+','-','=','*','%','&','#','@','$'
    ];
    const all = new Set([...HAN.split(''), ...punctArr]);
    let idx = 0;
    for (const c of all) {
      if (c && !(c in this.charToId) && idx < this.vocabSize) {
        this.charToId[c] = idx;
        this.idToChar[idx] = c;
        idx++;
      }
    }
    if (!this.charToId['?']) { this.charToId['?'] = idx; this.idToChar[idx] = HAN[0]; }
    this._actualVocabSize = idx;
  }

  lookup(ch) { return this.charToId[ch] !== undefined ? this.charToId[ch] : this.charToId['?']; }

  // ===== 前向传播 =====
  forward(ids, teacherTargetId) {
    const n = ids.length;
    if (n === 0) return null;

    // Embedding + PE
    const h0 = [];
    for (let i = 0; i < n; i++) {
      const emb = this.W_emb[ids[i]];
      if (!emb) return null;
      const pe = this.pos_enc[Math.min(i, MAX_SEQ_LEN - 1)];
      const out = new Float64Array(EMBED_DIM);
      for (let d = 0; d < EMBED_DIM; d++) out[d] = emb[d] + pe[d];
      h0.push(out);
    }

    let h = h0;
    const cache = { ids, h0, layers: [] };

    for (let L = 0; L < NUM_LAYERS; L++) {
      const hBefore = h.map(r => copyVec(r));

      // LayerNorm 1
      h = h.map(r => lnNorm(r, this.ln1_g, this.ln1_b));

      // QKV
      const Q = h.map(r => matMul([r], this.W_q)[0]);
      const K = h.map(r => matMul([r], this.W_k)[0]);
      const V = h.map(r => matMul([r], this.W_v)[0]);

      // Multi-head causal attention
      const attnOut = [];
      for (let i = 0; i < n; i++) {
        const headOut = new Float64Array(EMBED_DIM);
        for (let head = 0; head < NUM_HEADS; head++) {
          const qSlice = Q[i].subarray(head * HEAD_DIM, (head + 1) * HEAD_DIM);
          const scores = [];
          for (let j = 0; j <= i; j++) {
            const kSlice = K[j].subarray(head * HEAD_DIM, (head + 1) * HEAD_DIM);
            let s = 0;
            for (let d = 0; d < HEAD_DIM; d++) s += qSlice[d] * kSlice[d];
            scores.push(s / Math.sqrt(HEAD_DIM));
          }
          const w = softmax(scores);
          const out = new Float64Array(HEAD_DIM);
          for (let j = 0; j < w.length; j++)
            for (let d = 0; d < HEAD_DIM; d++)
              out[d] += w[j] * V[j].subarray(head * HEAD_DIM, (head + 1) * HEAD_DIM)[d];
          for (let d = 0; d < HEAD_DIM; d++) headOut[head * HEAD_DIM + d] += out[d];
        }
        attnOut.push(matMul([headOut], this.W_o)[0]);
      }

      // Residual
      h = hBefore.map((ri, i) => vecAdd(ri, attnOut[i]));

      // LayerNorm 2
      h = h.map(r => lnNorm(r, this.ln2_g, this.ln2_b));

      // FFN
      const preGelu = [];
      const ffnOut = [];
      for (let i = 0; i < n; i++) {
        const hid = matMul([h[i]], this.W_ff1)[0];
        const z = new Float64Array(HIDDEN_DIM);
        for (let j = 0; j < HIDDEN_DIM; j++) z[j] = hid[j] + this.b_ff1[j];
        preGelu.push(z);
        const act = new Float64Array(HIDDEN_DIM);
        for (let j = 0; j < HIDDEN_DIM; j++) act[j] = gelu(z[j]);
        ffnOut.push(matMul([act], this.W_ff2)[0]);
      }

      // Residual + b_ff2
      h = hBefore.map((ri, i) => vecAdd(ri, vecAdd(ffnOut[i], this.b_ff2)));

      cache.layers.push({ hBefore, Q, K, V, attnOut, preGelu, ffnOut });
    }

    // Output head
    const logits = matMul(h, this.W_out);
    const lt = logits[logits.length - 1];

    if (teacherTargetId !== undefined && teacherTargetId < this.vocabSize) {
      let maxL = -Infinity;
      for (let i = 0; i < lt.length; i++) if (lt[i] > maxL) maxL = lt[i];
      let sum = 0;
      for (let i = 0; i < lt.length; i++) sum += Math.exp(Math.min(lt[i] - maxL, 50));
      const prob = Math.exp(Math.min(lt[teacherTargetId] - maxL, 50)) / sum;
      const ceLoss = -Math.log(Math.max(prob, 1e-10));
      return { loss: ceLoss, logits: lt, cache };
    }

    let bestId = 0, bestLogit = -Infinity;
    for (let i = 0; i < lt.length; i++) if (lt[i] > bestLogit) { bestLogit = lt[i]; bestId = i; }
    return { loss: null, logits: lt, nextId: bestId, cache };
  }

  // ===== 生成文本 =====
  generate(ctxStr, maxTokens = 60, stopCh = '。！？!?') {
    let text = '', ctx = ctxStr;
    for (let i = 0; i < maxTokens; i++) {
      const ids = ctx.split('').map(c => this.lookup(c)).filter(x => x !== undefined);
      if (ids.length === 0) break;
      const r = this.forward(ids);
      if (!r || r.nextId === undefined) break;
      const ch = this.idToChar[r.nextId] || '?';
      text += ch;
      ctx += ch;
      if (stopCh.includes(ch) && text.length >= 3) break;
    }
    return text;
  }

  // ===== 训练（手动反向传播）=====
  trainStep(inputStr, targetStr, lr = 0.01) {
    const ids = inputStr.split('').map(c => this.lookup(c)).filter(x => x !== undefined);
    const tgt = targetStr.split('').map(c => this.lookup(c)).filter(x => x !== undefined);
    if (ids.length === 0 || tgt.length === 0) return 0;

    let totalLoss = 0;
    const numSteps = Math.min(tgt.length, 16);

    for (let step = 0; step < numSteps; step++) {
      const ctxIds = [];
      for (const id of ids) ctxIds.push(id);          // input 先
      for (let k = 0; k < step; k++) ctxIds.push(tgt[k]);  // target 前缀后
      const clippedCtx = ctxIds.slice(-MAX_SEQ_LEN);

      const r = this.forward(clippedCtx, tgt[step]);
      if (!r || r.loss === undefined || !isFinite(r.loss)) continue;
      totalLoss += r.loss;

      const lt = r.logits;
      const probs = softmax(lt);
      const dLogit = new Float64Array(lt.length);
      for (let i = 0; i < lt.length; i++) dLogit[i] = probs[i];
      dLogit[tgt[step]] -= 1.0;

      const lastLayer = r.cache.layers[NUM_LAYERS - 1];
      const lastIdx = clippedCtx.length - 1;
      const lastH = lastLayer.hBefore[lastIdx];

      // --- W_out gradient ---
      for (let d = 0; d < EMBED_DIM; d++) {
        for (let v = 0; v < this.vocabSize; v++) {
          const g = lastH[d] * dLogit[v];
          this.W_out[d][v] -= lr * clip(g, CLIP);
        }
      }

      // --- b_ff2 gradient ---
      for (let d = 0; d < EMBED_DIM; d++)
        this.b_ff2[d] -= lr * clip(dLogit[d], CLIP);

      // --- W_ff2 gradient ---
      const lastPreGelu = lastLayer.preGelu[lastIdx];
      const dHOut = new Float64Array(EMBED_DIM);
      for (let d = 0; d < EMBED_DIM; d++) dHOut[d] = dLogit[d];
      const dGelu = new Float64Array(HIDDEN_DIM);
      for (let j = 0; j < HIDDEN_DIM; j++)
        for (let d = 0; d < EMBED_DIM; d++)
          dGelu[j] += this.W_ff2[j][d] * dHOut[d];
      for (let j = 0; j < HIDDEN_DIM; j++)
        for (let d = 0; d < EMBED_DIM; d++) {
          const g = lastPreGelu[j] * dGelu[d];
          this.W_ff2[j][d] -= lr * clip(g, CLIP);
        }

      // --- b_ff1 gradient ---
      for (let j = 0; j < HIDDEN_DIM; j++) {
        const z = lastPreGelu[j] + this.b_ff1[j];
        const dg = gelu_d(z);
        this.b_ff1[j] -= lr * clip(dGelu[j] * dg, CLIP);
      }

      // --- dH after FFN ---
      const dH = new Float64Array(EMBED_DIM);
      for (let d = 0; d < EMBED_DIM; d++)
        for (let j = 0; j < HIDDEN_DIM; j++)
          dH[d] += this.W_ff1[d][j] * dGelu[j] * clip(gelu_d(lastPreGelu[j] + this.b_ff1[j]), CLIP);

      // --- W_o gradient ---
      const lastAttnOut = lastLayer.attnOut[lastIdx];
      for (let d = 0; d < EMBED_DIM; d++)
        for (let v = 0; v < EMBED_DIM; v++) {
          const g = lastAttnOut[v] * dH[d] * 0.3;
          this.W_o[d][v] -= lr * clip(g, CLIP);
        }

      // --- Embedding gradient (input tokens) ---
      const inputCount = ids.length;
      const updateLast = Math.min(inputCount, 4);
      for (let ii = inputCount - updateLast; ii < inputCount; ii++) {
        const tid = clippedCtx[ii];
        if (tid === undefined) continue;
        for (let d = 0; d < EMBED_DIM; d++)
          this.W_emb[tid][d] -= lr * 0.1 * clip(dH[d], CLIP);
      }
    }

    return totalLoss / Math.max(1, numSteps);
  }

  // ===== 批量训练 =====
  trainBatch(pairs, epochs = 3, lr = 0.005) {
    for (let ep = 0; ep < epochs; ep++)
      for (const pair of pairs)
        this.trainStep(pair.input, pair.output, lr);
    return this;
  }

  // ===== 保存/加载 =====
  save(dir) {
    const toArr2D = m => m.map(row => Array.from(row));
    const data = {
      version: 2, vocabSize: this.vocabSize,
      charToId: this.charToId, idToChar: this.idToChar,
      W_emb: toArr2D(this.W_emb), W_q: toArr2D(this.W_q), W_k: toArr2D(this.W_k),
      W_v: toArr2D(this.W_v), W_o: toArr2D(this.W_o),
      W_ff1: toArr2D(this.W_ff1), W_ff2: toArr2D(this.W_ff2),
      b_ff1: [...this.b_ff1], b_ff2: [...this.b_ff2],
      ln1_g: [...this.ln1_g], ln1_b: [...this.ln1_b],
      ln2_g: [...this.ln2_g], ln2_b: [...this.ln2_b],
      W_out: toArr2D(this.W_out), pos_enc: toArr2D(this.pos_enc),
    };
    fs.writeFileSync(path.join(dir, 'transformer.json'), JSON.stringify(data), 'utf8');
  }

  static load(dir) {
    const f = path.join(dir, 'transformer.json');
    if (!fs.existsSync(f)) return null;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const t = new Transformer(data.vocabSize || 3000);
    Object.assign(t, data);
    t.W_emb = data.W_emb; t.W_q = data.W_q; t.W_k = data.W_k;
    t.W_v = data.W_v; t.W_o = data.W_o; t.W_ff1 = data.W_ff1; t.W_ff2 = data.W_ff2;
    t.b_ff1 = new Float64Array(data.b_ff1); t.b_ff2 = new Float64Array(data.b_ff2);
    t.ln1_g = new Float64Array(data.ln1_g); t.ln1_b = new Float64Array(data.ln1_b);
    t.ln2_g = new Float64Array(data.ln2_g); t.ln2_b = new Float64Array(data.ln2_b);
    t.W_out = data.W_out; t.pos_enc = data.pos_enc;
    return t;
  }

  paramCount() {
    let n = this.vocabSize * EMBED_DIM;
    n += 4 * EMBED_DIM * EMBED_DIM; // W_q, W_k, W_v, W_o
    n += EMBED_DIM * HIDDEN_DIM * 2; // W_ff1, W_ff2
    n += 2 * EMBED_DIM; // b_ff1, b_ff2
    n += 4 * EMBED_DIM; // ln g/b
    n += EMBED_DIM * this.vocabSize; // W_out
    n += MAX_SEQ_LEN * EMBED_DIM; // pos_enc
    return n;
  }
}

module.exports = { Transformer };
