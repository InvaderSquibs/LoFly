/**
 * LoFly live scoring (browser port of engine pheromone blend).
 * Camelot + tempo + chroma courtship drive + novelty.
 */
(function (global) {
  "use strict";

  const W_CAMELOT = 0.42;
  const W_TEMPO = 0.25;
  const W_COURTSHIP = 0.2;
  const W_NOVELTY = 0.13;
  const CAMELOT_OK = { same: 1, relative: 1, adjacent: 1, diagonal: 1 };
  const CLASH_PENALTY = 0.72;
  const CAMELOT_BOOST = 1.08;
  const STICKY_MARGIN = 0.08; // harder to steal attention
  const GLANCE_SEC = 7; // how long one other track stays in view
  const TICK_SEC = 20;
  const MIN_TICKS = 3;
  const MAX_TICKS = 12;

  const DEFAULT_TOGGLES = {
    clash_penalty: false,
    novelty: true,
    camelot_boost: false,
    // Prefer relative/adjacent(/diagonal) over staying on the same Camelot code
    prefer_complement: true,
  };

  /** Remap Camelot kind → score; when prefer_complement, peak on wheel moves not "same". */
  function camelotFlowScore(kind, baseScore, preferComplement) {
    if (!preferComplement) return baseScore;
    const table = {
      relative: 1.0,
      adjacent: 0.97,
      diagonal: 0.78,
      same: 0.42,
      two_apart: 0.28,
      clash: 0.12,
      unknown: 0.1,
    };
    return table[kind] != null ? table[kind] : baseScore * 0.5;
  }

  function parseCamelot(code) {
    if (!code || code.length < 2) return null;
    const letter = code.slice(-1).toUpperCase();
    const num = parseInt(code.slice(0, -1), 10);
    if ((letter !== "A" && letter !== "B") || !(num >= 1 && num <= 12)) return null;
    return { num, letter };
  }

  function camelotDistance(a, b) {
    const pa = parseCamelot(a);
    const pb = parseCamelot(b);
    if (!pa || !pb) return { kind: "unknown", score: 0, number_delta: null, letter_flip: null };
    const d = Math.min((pa.num - pb.num + 12) % 12, (pb.num - pa.num + 12) % 12);
    const flip = pa.letter !== pb.letter;
    let kind;
    let score;
    if (d === 0 && !flip) {
      kind = "same";
      score = 1;
    } else if (d === 0 && flip) {
      kind = "relative";
      score = 0.92;
    } else if (d === 1 && !flip) {
      kind = "adjacent";
      score = 0.88;
    } else if (d === 1 && flip) {
      kind = "diagonal";
      score = 0.55;
    } else if (d === 2 && !flip) {
      kind = "two_apart";
      score = 0.35;
    } else {
      kind = "clash";
      score = Math.max(0, 0.25 - 0.05 * d);
    }
    return { kind, score, number_delta: d, letter_flip: flip };
  }

  function tempoCompatibility(bpmA, bpmB) {
    if (!(bpmA > 0) || !(bpmB > 0)) return { score: 0.5, delta_pct: 0 };
    const ratios = [bpmB / bpmA, (2 * bpmB) / bpmA, bpmB / (2 * bpmA)];
    let best = ratios[0];
    let bestAbs = Math.abs(best - 1);
    for (let i = 1; i < ratios.length; i++) {
      const a = Math.abs(ratios[i] - 1);
      if (a < bestAbs) {
        best = ratios[i];
        bestAbs = a;
      }
    }
    const deltaPct = bestAbs * 100;
    let score;
    if (deltaPct <= 6) score = 1 - 0.15 * (deltaPct / 6);
    else if (deltaPct <= 12) score = 0.55 - 0.25 * ((deltaPct - 6) / 6);
    else score = Math.max(0.05, 0.3 - 0.02 * (deltaPct - 12));
    return { score, delta_pct: deltaPct };
  }

  function chromaDistance(a, b) {
    if (!a || !b || a.length !== 12 || b.length !== 12) return 0.5;
    let na = 0;
    let nb = 0;
    let dot = 0;
    for (let i = 0; i < 12; i++) {
      const x = Number(a[i]) || 0;
      const y = Number(b[i]) || 0;
      na += x * x;
      nb += y * y;
      dot += x * y;
    }
    na = Math.sqrt(na);
    nb = Math.sqrt(nb);
    if (na < 1e-9 || nb < 1e-9) return 0.5;
    const cos = Math.max(-1, Math.min(1, dot / (na * nb)));
    return 0.5 * (1 - cos);
  }

  function courtshipDrive(camelotScore, chromaDist, tempoScore, playFamiliarity) {
    const harmonic = camelotScore * (0.35 + 0.65 * chromaDist);
    const cohesion = 0.5 + 0.5 * tempoScore;
    const raw = harmonic * cohesion;
    const damped = raw * (1 - 0.75 * playFamiliarity);
    const drive = Math.max(0, Math.min(1, damped));
    return {
      courtship_drive: drive,
      harmonic_salience: harmonic,
      chroma_distance: chromaDist,
      play_familiarity: playFamiliarity,
      targets: ["courtship_pC1", "courtship_vPR6", "courtship_TN1", "DAN"],
    };
  }

  function noveltyScore(trackId, pc, peerIds) {
    const counts = (pc && pc.counts) || {};
    const n = counts[trackId] || 0;
    let fam;
    if (!peerIds || !peerIds.length) {
      fam = Math.min(1, n / 3);
    } else {
      let sum = 0;
      for (let i = 0; i < peerIds.length; i++) sum += counts[peerIds[i]] || 0;
      const meanP = sum / peerIds.length;
      fam = meanP < 1e-9 ? Math.min(1, n / 3) : Math.min(1, n / (meanP + 1));
    }
    return { novelty: Math.max(0, Math.min(1, 1 - 0.85 * fam)), fam };
  }

  function nTicksFor(durationS) {
    const n = Math.floor(Number(durationS) / TICK_SEC);
    return Math.max(MIN_TICKS, Math.min(MAX_TICKS, n > 0 ? n : MIN_TICKS));
  }

  function scoreCandidate(playing, candidate, pc, peerIds, toggles, chromaOpts) {
    const t = Object.assign({}, DEFAULT_TOGGLES, toggles || {});
    const opts = chromaOpts || {};
    // Moment slices replace full-song means when provided (short memory)
    const playChroma = opts.playingChroma || playing.chroma_mean;
    const candChroma = opts.candidateChroma || candidate.chroma_mean;
    const playingView = Object.assign({}, playing, { chroma_mean: playChroma });
    const candidateView = Object.assign({}, candidate, { chroma_mean: candChroma });

    const cam = camelotDistance(playingView.camelot, candidateView.camelot);
    const camScore = camelotFlowScore(cam.kind, cam.score, t.prefer_complement);
    const tempo = tempoCompatibility(playingView.bpm, candidateView.bpm);
    const { novelty, fam } = noveltyScore(candidateView.id, pc, peerIds);
    const cdist = chromaDistance(playChroma, candChroma);
    const court = courtshipDrive(
      camScore,
      cdist,
      tempo.score,
      t.novelty ? fam : 0
    );
    const drive = court.courtship_drive;
    let raw;
    if (t.novelty) {
      raw =
        W_CAMELOT * camScore +
        W_TEMPO * tempo.score +
        W_COURTSHIP * drive +
        W_NOVELTY * novelty;
    } else {
      const s = W_CAMELOT + W_TEMPO + W_COURTSHIP;
      raw =
        (W_CAMELOT / s) * camScore +
        (W_TEMPO / s) * tempo.score +
        (W_COURTSHIP / s) * drive;
    }
    if (t.clash_penalty && !CAMELOT_OK[cam.kind]) raw *= CLASH_PENALTY;
    if (t.camelot_boost) {
      if (cam.kind === "relative" || cam.kind === "adjacent" || cam.kind === "diagonal") {
        raw *= CAMELOT_BOOST;
      } else if (cam.kind === "same" && !t.prefer_complement) {
        raw *= CAMELOT_BOOST;
      }
    }
    if (t.prefer_complement && cam.kind === "same") {
      raw *= 0.85;
    }
    const pheromone = Math.max(0, Math.min(1, raw));
    return {
      track_id: candidate.id,
      title: candidate.title,
      camelot: candidate.camelot,
      bpm: candidate.bpm,
      path: candidate.path,
      pheromone,
      camelot_kind: cam.kind,
      camelot_score: camScore,
      tempo_score: tempo.score,
      novelty,
      courtship: court,
      chroma_slice: candChroma,
    };
  }

  function promotePheromones(playing, tracks, exclude, pc, toggles) {
    const peerIds = Object.keys(tracks).filter(
      (id) => id !== playing.id && !exclude.has(id)
    );
    const scored = peerIds.map((id) =>
      scoreCandidate(playing, tracks[id], pc, peerIds, toggles)
    );
    scored.sort((a, b) => b.pheromone - a.pheromone);
    return scored;
  }

  function pickRandom(arr, rng) {
    return arr[Math.floor(rng() * arr.length)];
  }

  function chromaAtProgress(track, progress) {
    const tl = track.chroma_timeline;
    if (!tl || !tl.length) return track.chroma_mean || Array(12).fill(0.08);
    const p = Math.max(0, Math.min(0.999, progress));
    const idx = Math.min(tl.length - 1, Math.floor(p * tl.length));
    return tl[idx];
  }

  /** One remembered slice of a track — not the full-song mean. */
  function glimpseChroma(track, rng) {
    const tl = track.chroma_timeline;
    if (!tl || !tl.length) return track.chroma_mean || Array(12).fill(0.08);
    return tl[Math.floor(rng() * tl.length)];
  }

  function eligibleIds(tracks, exclude) {
    return Object.keys(tracks).filter((id) => !exclude.has(id));
  }

  /**
   * Score one candidate against the heard moment (serial glance model).
   */
  function scoreGlance(playing, playingChroma, candidate, candidateChroma, pc, toggles) {
    const peerIds = [candidate.id];
    return scoreCandidate(playing, candidate, pc, peerIds, toggles, {
      playingChroma,
      candidateChroma,
    });
  }

  global.LoFlyLive = {
    STICKY_MARGIN,
    GLANCE_SEC,
    TICK_SEC,
    DEFAULT_TOGGLES,
    nTicksFor,
    promotePheromones,
    scoreCandidate,
    scoreGlance,
    pickRandom,
    chromaAtProgress,
    glimpseChroma,
    eligibleIds,
    camelotDistance,
    courtshipDrive,
  };
})(window);
