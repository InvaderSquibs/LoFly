"""
Run one representative trial per stimulus class, capturing per-neuron spike
times (not just aggregate rates), and export a compact JSON for an animated
visualization: a per-group binned population-rate curve (full population)
plus a sampled per-neuron raster (a representative subset per group, so the
file stays small) showing the real biological cascade ORN -> PN -> KC ->
MBON/DAN -> descending neuron.
"""
import json
import numpy as np
import pandas as pd
import run_perception_experiment as rpe
from brian2 import Network, PoissonInput, Hz, ms

BIN_MS = 3.0
T_RUN_MS = 300.0
SAMPLE_PER_GROUP = 40

pathway_order = ['stim_A_ORN_DA1', 'stim_B_ORN_DL3', 'ALPN', 'Kenyon_Cell', 'MBON', 'DAN', 'descending']
pretty = {
    'stim_A_ORN_DA1': 'ORN (pheromone, DA1)',
    'stim_B_ORN_DL3': 'ORN (food odor, DL3)',
    'ALPN': 'Antennal-lobe PN',
    'Kenyon_Cell': 'Kenyon cell',
    'MBON': 'MBON',
    'DAN': 'Dopaminergic neuron',
    'descending': 'Descending (motor)',
}

idx_of_group = {g: [i for i, b in enumerate(rpe.node_ids) if rpe.group_of[b] == g] for g in pathway_order}

rng = np.random.RandomState(0)
sample_idx_of_group = {}
for g, idxs in idx_of_group.items():
    if len(idxs) <= SAMPLE_PER_GROUP:
        sample_idx_of_group[g] = idxs
    else:
        sample_idx_of_group[g] = sorted(rng.choice(idxs, size=SAMPLE_PER_GROUP, replace=False).tolist())

n_bins = int(np.ceil(T_RUN_MS / BIN_MS))

def run_and_capture(stim_group_name, seed):
    np.random.seed(seed)
    neu, syn, spk_mon = rpe.build_network()
    start, stop = rpe.group_ranges[stim_group_name]
    net = Network(neu, syn, spk_mon)
    pois = PoissonInput(target=neu[start:stop], target_var='v', N=1,
                         rate=150 * Hz, weight=rpe.params['w_syn'] * rpe.params['f_poi'])
    neu.rfc[start:stop] = 0 * ms
    net.add(pois)
    net.run(T_RUN_MS * ms)

    spike_trains = spk_mon.spike_trains()  # idx -> array of times (with units)

    out = {'rate_curves': {}, 'raster': {}, 'group_sizes': {}}
    for g in pathway_order:
        idxs = idx_of_group[g]
        out['group_sizes'][g] = len(idxs)
        # population rate curve (Hz), using ALL neurons in the group
        binned_counts = np.zeros(n_bins)
        for idx in idxs:
            times_ms = np.array(spike_trains.get(idx, []) / ms)
            if len(times_ms):
                bin_idx = np.clip((times_ms // BIN_MS).astype(int), 0, n_bins - 1)
                np.add.at(binned_counts, bin_idx, 1)
        rate_hz = binned_counts / max(len(idxs), 1) / (BIN_MS / 1000.0)
        out['rate_curves'][g] = [round(float(x), 2) for x in rate_hz]

        # sampled raster (a representative subset of neurons)
        raster_rows = []
        for row_i, idx in enumerate(sample_idx_of_group[g]):
            times_ms = np.array(spike_trains.get(idx, []) / ms)
            raster_rows.append([round(float(t), 2) for t in times_ms.tolist()])
        out['raster'][g] = raster_rows

    return out

data = {
    'bin_ms': BIN_MS,
    't_run_ms': T_RUN_MS,
    'sample_per_group': SAMPLE_PER_GROUP,
    'pathway_order': pathway_order,
    'pretty_names': pretty,
    'conditions': {
        'pheromone': run_and_capture('stim_A_ORN_DA1', seed=1),
        'food_odor': run_and_capture('stim_B_ORN_DL3', seed=2),
    },
}

with open('viz_data.json', 'w') as f:
    json.dump(data, f)

import os
print('wrote viz_data.json, size bytes =', os.path.getsize('viz_data.json'))
