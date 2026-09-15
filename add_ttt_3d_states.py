"""
Append per-neuron spike/rate data for additional board states to the existing
ttt_3d_data.json (positions/hub-positions/group metadata are reused as-is,
only new 'states' entries are added and merged in, checkpointed each state).
"""
import sys
import json
import numpy as np
from brian2 import Network, PoissonInput, ms, Hz

import ttt_brain as brain

OUT_PATH = 'ttt_3d_data.json'

with open(OUT_PATH) as f:
    data = json.load(f)

located_idx = set(int(k) for k in data['positions'].keys())


def board_key(b):
    return ''.join(str(v) for v in b)


def simulate_neuron_spikes(board):
    neu, syn, spk_mon = brain.build_network()
    net = Network(neu, syn, spk_mon)
    pois_objs = []
    for i, state in enumerate(board):
        rate = brain.RATE_EMPTY if state == 0 else (brain.RATE_FLY if state == 1 else brain.RATE_OPP)
        if rate <= 0:
            continue
        start, stop = brain.group_ranges[brain.cell_group_names[i]]
        p = PoissonInput(target=neu[start:stop], target_var='v', N=1, rate=rate * Hz,
                          weight=brain.params['w_syn'] * brain.params['f_poi'])
        pois_objs.append(p)
        neu.rfc[start:stop] = 0 * ms
    if pois_objs:
        net.add(*pois_objs)
    net.run(brain.T_RUN_MS * ms)

    spike_trains = spk_mon.spike_trains()
    out_spikes, out_rate = {}, {}
    for idx in range(brain.N):
        if idx not in located_idx:
            continue
        times = spike_trains.get(idx, [])
        if len(times):
            out_spikes[idx] = [round(float(t) * 1000.0, 1) for t in times]
        r = len(times) / (brain.T_RUN_MS / 1000.0)
        if r > 0:
            out_rate[idx] = round(r, 2)
    return out_spikes, out_rate


new_boards = json.loads(sys.argv[1])
for board in new_boards:
    key = board_key(board)
    if key in data['states']:
        print('skip (already have)', key)
        continue
    spikes, rates = simulate_neuron_spikes(board)
    data['states'][key] = {'spikes': {str(k): v for k, v in spikes.items()},
                            'rates': {str(k): v for k, v in rates.items()}}
    with open(OUT_PATH, 'w') as f:
        json.dump(data, f)
    print(key, len(spikes), 'located neurons spiked')

print('total states now:', len(data['states']))
