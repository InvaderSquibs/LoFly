"""
Extract LoFly subgraph from MaleCNS.

Listening (current song):
  12 ORN glomeruli ← 12 chroma pitch-class channels (reservoir mapping)
  ALPN → Kenyon_Cell → MBON → DAN  (shared fly-experience pathway)

Courtship activation (strong harmonic change between mixes):
  pC1_* , vPR6 , TN1*  driven separately by courtship_drive

Writes feathers into this activity folder (does not touch TTT subgraph).

  cd /path/to/fly-brain
  python3 fly_console/activities/lofly/extract_subgraph.py
"""
from __future__ import annotations

import time
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as feather

ACTIVITY_DIR = Path(__file__).resolve().parent
REPO_ROOT = ACTIVITY_DIR.parents[2]

# 12 pitch-class channels (C … B) → 12 real ORN types
CHROMA_ORN_TYPES = [
    "ORN_DA1",
    "ORN_VA1d",
    "ORN_VA1v",
    "ORN_DL3",
    "ORN_VL2a",
    "ORN_VM5d",
    "ORN_VA2",
    "ORN_DL1",
    "ORN_VL1",
    "ORN_VM4",
    "ORN_DM1",
    "ORN_VA6",
]

t0 = time.time()
ann = pd.read_feather(REPO_ROOT / "body-annotations-male-cns-v1.0-minconf-0.5.feather")

node_groups = {}
for i, t in enumerate(CHROMA_ORN_TYPES):
    ids = ann.loc[ann["type"] == t, "bodyId"].tolist()
    node_groups[f"chroma_{i}_{t}"] = ids

node_groups["ALPN"] = ann.loc[ann["class"] == "ALPN", "bodyId"].tolist()
node_groups["Kenyon_Cell"] = ann.loc[ann["class"] == "Kenyon_Cell", "bodyId"].tolist()
node_groups["MBON"] = ann.loc[ann["class"] == "MBON", "bodyId"].tolist()
node_groups["DAN"] = ann.loc[ann["class"] == "DAN", "bodyId"].tolist()

# Courtship / song-related types
pc1_mask = ann["type"].astype(str).str.startswith("pC1_")
node_groups["courtship_pC1"] = ann.loc[pc1_mask, "bodyId"].tolist()
node_groups["courtship_vPR6"] = ann.loc[ann["type"] == "vPR6", "bodyId"].tolist()
tn1_mask = ann["type"].astype(str).str.startswith("TN1")
node_groups["courtship_TN1"] = ann.loc[tn1_mask, "bodyId"].tolist()

all_nodes = []
for name, ids in node_groups.items():
    print(f"{name}: {len(ids)} neurons")
    all_nodes.extend(ids)
node_set = set(all_nodes)
print(f"TOTAL unique nodes: {len(node_set)}")

node_id_array = pa.array(list(node_set), type=pa.int64())
src = pa.memory_map(
    str(REPO_ROOT / "connectome-weights-male-cns-v1.0-minconf-0.5.feather"), "r"
)
reader = pa.ipc.open_file(src)
n_batches = reader.num_record_batches
print(f"Streaming {n_batches} batches...")

filtered_batches = []
for i in range(n_batches):
    batch = reader.get_batch(i)
    pre_in = pc.is_in(batch.column("body_pre"), value_set=node_id_array)
    post_in = pc.is_in(batch.column("body_post"), value_set=node_id_array)
    mask = pc.and_(pre_in, post_in)
    if pc.sum(mask).as_py():
        filtered_batches.append(batch.filter(mask))

sub_table = pa.Table.from_batches(filtered_batches)
sub_df = sub_table.to_pandas()
print(f"Induced subgraph: {len(sub_df)} edges among {len(node_set)} nodes")

edges_path = ACTIVITY_DIR / "lofly_subgraph_edges.feather"
nodes_path = ACTIVITY_DIR / "lofly_subgraph_nodes.feather"
feather.write_feather(sub_df, edges_path)

rows = []
for name, ids in node_groups.items():
    for bid in ids:
        rows.append({"bodyId": bid, "group": name})
pd.DataFrame(rows).to_feather(nodes_path)

print(f"Wrote {edges_path.name}, {nodes_path.name} in {time.time() - t0:.1f}s")
