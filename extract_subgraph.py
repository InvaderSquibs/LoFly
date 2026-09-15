"""
Extract a tractable induced subgraph from the MaleCNS v1.0 connectome for a
perception/decoding experiment:

Pathway: ORN (two odor/pheromone glomeruli) -> ALPN -> Kenyon_Cell -> MBON
         plus DAN (reinforcement) and descending_neuron (motor output).

Streams the 151.8M-row connectivity file in its native Arrow record batches
so we never materialize the full table (the VM only has ~3.8GB RAM).
"""
import time
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as feather
import pandas as pd

t0 = time.time()

ann = pd.read_feather('body-annotations-male-cns-v1.0-minconf-0.5.feather')

stim_a_type = 'ORN_DA1'   # pheromone (cVA) glomerulus
stim_b_type = 'ORN_DL3'   # food-odor glomerulus

node_groups = {
    'stim_A_ORN_DA1': ann.loc[ann['type'] == stim_a_type, 'bodyId'].tolist(),
    'stim_B_ORN_DL3': ann.loc[ann['type'] == stim_b_type, 'bodyId'].tolist(),
    'ALPN':           ann.loc[ann['class'] == 'ALPN', 'bodyId'].tolist(),
    'Kenyon_Cell':    ann.loc[ann['class'] == 'Kenyon_Cell', 'bodyId'].tolist(),
    'MBON':           ann.loc[ann['class'] == 'MBON', 'bodyId'].tolist(),
    'DAN':            ann.loc[ann['class'] == 'DAN', 'bodyId'].tolist(),
    'descending':     ann.loc[ann['superclass'] == 'descending_neuron', 'bodyId'].tolist(),
}

all_nodes = []
for name, ids in node_groups.items():
    print(f'{name}: {len(ids)} neurons')
    all_nodes.extend(ids)

node_set = set(all_nodes)
print(f'TOTAL unique nodes: {len(node_set)}')

node_id_array = pa.array(list(node_set), type=pa.int64())

src = pa.memory_map('connectome-weights-male-cns-v1.0-minconf-0.5.feather', 'r')
reader = pa.ipc.open_file(src)
n_batches = reader.num_record_batches
print(f'Streaming {n_batches} batches...')

filtered_batches = []
total_rows_seen = 0
for i in range(n_batches):
    batch = reader.get_batch(i)
    total_rows_seen += batch.num_rows
    pre_in = pc.is_in(batch.column('body_pre'), value_set=node_id_array)
    post_in = pc.is_in(batch.column('body_post'), value_set=node_id_array)
    mask = pc.and_(pre_in, post_in)
    if pc.sum(mask).as_py():
        filtered_batches.append(batch.filter(mask))
    if (i + 1) % 200 == 0:
        elapsed = time.time() - t0
        print(f'  batch {i+1}/{n_batches}  rows_seen={total_rows_seen}  elapsed={elapsed:.1f}s')

sub_table = pa.Table.from_batches(filtered_batches) if filtered_batches else None
sub_df = sub_table.to_pandas()
print(f'Induced subgraph: {len(sub_df)} edges among {len(node_set)} nodes')

feather.write_feather(sub_df, 'subgraph_edges.feather')

rows = []
for name, ids in node_groups.items():
    for bid in ids:
        rows.append({'bodyId': bid, 'group': name})
pd.DataFrame(rows).to_feather('subgraph_nodes.feather')

print(f'Done in {time.time()-t0:.1f}s')
