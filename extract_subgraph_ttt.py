"""
Extract the induced subgraph for the tic-tac-toe experiment:
  - 9 real ORN glomeruli, one per board cell (input channels)
  - ALPN, Kenyon_Cell, MBON, DAN (processing / reward pathway)
  - 9 real descending-neuron types, one per possible move (output channels)
"""
import time
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as feather
import pandas as pd

t0 = time.time()
ann = pd.read_feather('body-annotations-male-cns-v1.0-minconf-0.5.feather')

CELL_ORN_TYPES = ['ORN_DA1', 'ORN_VA1d', 'ORN_VA1v', 'ORN_DL3', 'ORN_VL2a',
                   'ORN_VM5d', 'ORN_VA2', 'ORN_DL1', 'ORN_VL1']
MOVE_DN_TYPES = ['DNa03', 'DNg104', 'DNp42', 'DNa02', 'DNp52',
                  'DNa13', 'DNge138', 'DNge150', 'DNp68']

node_groups = {}
for i, t in enumerate(CELL_ORN_TYPES):
    node_groups[f'cell_{i}_{t}'] = ann.loc[ann['type'] == t, 'bodyId'].tolist()
for i, t in enumerate(MOVE_DN_TYPES):
    node_groups[f'move_{i}_{t}'] = ann.loc[ann['type'] == t, 'bodyId'].tolist()

node_groups['ALPN'] = ann.loc[ann['class'] == 'ALPN', 'bodyId'].tolist()
node_groups['Kenyon_Cell'] = ann.loc[ann['class'] == 'Kenyon_Cell', 'bodyId'].tolist()
node_groups['MBON'] = ann.loc[ann['class'] == 'MBON', 'bodyId'].tolist()
node_groups['DAN'] = ann.loc[ann['class'] == 'DAN', 'bodyId'].tolist()

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
for i in range(n_batches):
    batch = reader.get_batch(i)
    pre_in = pc.is_in(batch.column('body_pre'), value_set=node_id_array)
    post_in = pc.is_in(batch.column('body_post'), value_set=node_id_array)
    mask = pc.and_(pre_in, post_in)
    if pc.sum(mask).as_py():
        filtered_batches.append(batch.filter(mask))

sub_table = pa.Table.from_batches(filtered_batches)
sub_df = sub_table.to_pandas()
print(f'Induced subgraph: {len(sub_df)} edges among {len(node_set)} nodes')
feather.write_feather(sub_df, 'ttt_subgraph_edges.feather')

rows = []
for name, ids in node_groups.items():
    for bid in ids:
        rows.append({'bodyId': bid, 'group': name})
pd.DataFrame(rows).to_feather('ttt_subgraph_nodes.feather')

print(f'Done in {time.time()-t0:.1f}s')
