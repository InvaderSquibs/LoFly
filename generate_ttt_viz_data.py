"""
Generate visualization data for the tic-tac-toe fly-brain: for a handful of
real board states (drawn from actual self-play games in ttt_game_log.jsonl),
run the connectome simulation and capture:
  - per-group firing rate (all 9 input cells, all 9 output moves, and the
    ALPN / Kenyon_Cell / MBON / DAN processing stages)
  - time-binned rate curves for the processing stages (for a cascade view)
  - a sampled spike raster for the processing stages (for a literal
    "watch the spikes fire" view)

Checkpointed: writes/updates ttt_viz_data.json after EVERY board state, so a
run can be resumed across multiple device_bash calls without losing work.
"""
import json
import sys
from pathlib import Path

import numpy as np
from brian2 import Network, PoissonInput, ms, Hz

import ttt_brain as brain

OUT_PATH = Path('ttt_viz_data.json')
BIN_MS = 3.0
N_BINS = int(brain.T_RUN_MS / BIN_MS)
SAMPLE_PER_GROUP = 40
RASTER_GROUPS = ['ALPN', 'Kenyon_Cell', 'MBON', 'DAN']


def simulate_with_raster(board, rng_seed=None):
    neu, syn, spk_mon = brain.build_network()
    net = Network(neu, syn, spk_mon)
    pois_objs = []
    for i, state in enumerate(board):
        rate = brain.RATE_EMPTY if state == 0 else (brain.RATE_FLY if state == 1 else brain.RATE_OPP)
        if rate <= 0:
            continue
        start, stop = brain.group_ranges[brain.cell_group_names[i]]
        p = PoissonInput(target=neu[start:stop], target_var='v', N=1,
                          rate=rate * Hz, weight=brain.params['w_syn'] * brain.params['f_poi'])
        pois_objs.append(p)
        neu.rfc[start:stop] = 0 * ms
    if pois_objs:
        net.add(*pois_objs)
    net.run(brain.T_RUN_MS * ms)

    spike_trains = spk_mon.spike_trains()
    counts_per_neuron = np.zeros(brain.N)
    for idx, times in spike_trains.items():
        counts_per_neuron[idx] = len(times)
    rate_hz = counts_per_neuron / (brain.T_RUN_MS / 1000.0)

    def group_rate(gname):
        start, stop = brain.group_ranges[gname]
        return float(rate_hz[start:stop].mean()) if stop > start else 0.0

    move_rates = [group_rate(g) for g in brain.move_group_names]
    cell_rates = [group_rate(g) for g in brain.cell_group_names]

    rate_curves = {}
    raster = {}
    for gname in RASTER_GROUPS:
        start, stop = brain.group_ranges[gname]
        idxs = np.arange(start, stop)
        # time-binned mean rate (Hz) across the whole group
        binned = np.zeros(N_BINS)
        for idx in idxs:
            times = spike_trains.get(idx, [])
            for t in times:
                b = int((float(t) * 1000.0) / BIN_MS)
                if 0 <= b < N_BINS:
                    binned[b] += 1
        n_group = max(1, stop - start)
        binned_hz = (binned / n_group) / (BIN_MS / 1000.0)
        rate_curves[gname] = [round(float(x), 2) for x in binned_hz]

        # sampled raster: up to SAMPLE_PER_GROUP neurons, their spike times (ms)
        sample_idxs = idxs if len(idxs) <= SAMPLE_PER_GROUP else np.linspace(
            start, stop - 1, SAMPLE_PER_GROUP).astype(int)
        raster[gname] = []
        for local_i, idx in enumerate(sample_idxs):
            times = spike_trains.get(int(idx), [])
            t_ms = [round(float(t) * 1000.0, 1) for t in times]
            if t_ms:
                raster[gname].append({'n': local_i, 't': t_ms})

    return dict(
        move_rates=[round(float(x), 2) for x in move_rates],
        cell_rates=[round(float(x), 2) for x in cell_rates],
        dan_rate=round(group_rate('DAN'), 2),
        kc_rate=round(group_rate('Kenyon_Cell'), 2),
        mbon_rate=round(group_rate('MBON'), 2),
        alpn_rate=round(group_rate('ALPN'), 2),
        rate_curves=rate_curves,
        raster=raster,
    )


def load_out():
    if OUT_PATH.exists():
        with open(OUT_PATH) as f:
            return json.load(f)
    return dict(board_states={}, example_games={}, learning_curve={}, meta={})


def save_out(data):
    tmp = OUT_PATH.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f)
    tmp.replace(OUT_PATH)


def board_key(board):
    return ''.join(str(v) for v in board)


def main():
    states_to_run = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    data = load_out()
    for board in states_to_run:
        key = board_key(board)
        if key in data['board_states']:
            print(f'skip (already computed): {key}')
            continue
        print(f'simulating board {board} ...')
        result = simulate_with_raster(board)
        result['board'] = board
        data['board_states'][key] = result
        save_out(data)
        print(f'  done, move_rates={result["move_rates"]}')
    print(f'total board_states cached: {len(data["board_states"])}')


if __name__ == '__main__':
    main()
