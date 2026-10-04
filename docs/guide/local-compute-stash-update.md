# Local Compute guide: stash section update

Drop-in copy for `guide.organizedai.vip/local-compute/`, written in the guide's voice
(plain, sourced, no time estimates). Two parts:

1. A rewrite of **Stash a model library on NVMe** (`#stash-library`): the one-pass pull
   described in the live page has been replaced by an agent that runs on every plug-in.
2. A new section, **Look inside the models** (`#interpretability`), placed after the
   stash section and before **A dedicated dev box for fine-tuning**.

Figures below were read from the A1 Scout catalog on October 4, 2026.

---

## Review: what the live page says vs. what the drive does now

| Live page says | Now | Change |
|---|---|---|
| Agent checks the target is **APFS** | The A1 is **exFAT** (formatted for both Macs and other machines). exFAT is slow with thousands of small files and can't hold a Python venv. | Say exFAT is fine for weights, keep venvs on the Mac's internal disk, and budget extra time for datasets made of many small files. |
| One-pass **eleven-phase pull**, then you're done | **a1-scout** runs on every plug-in: reads the drive, checks each stashed item for a newer revision, scans the Hub for picks, downloads what you approved. | Replace the phase table with the plug-in loop. Keep the safety rules. |
| Working set **45–60 GB** | **374 GB** in `stash/` today (models 317 GB, datasets 54 GB, the rest under 5 GB), 1.5 TB free on the 2 TB drive. | Update the sizes, and keep the advice that the drive does not need to be full. |
| **Pins table** dated October 1 | Pins live in `manifests/scout-pins.json`, written per download, newest entry wins. 78 items are pinned and stashed. | Replace the table with a description of where pins live and how updates move them. |
| "Pinned revisions only… never fetch a branch tip" | Still true for downloads. Updates now move a pin forward on purpose: the new revision downloads beside the old one, and the old one moves to `versions/`. | Explain the versioned update and the 24-hour settle rule. |
| xlam and ultrachat "stay off by default" | Both are on the drive (pulled by hand). | Note they're there, untracked by the updater. |
| Run on an **M1 MacBook Pro** | Still the M1, over a 40 Gb/s Thunderbolt 4 port. | No change. |
| No monitoring for the pull | A cloud dashboard shows live progress, average GB/s, time left, what's next, and a **Run now** button. | Add a short paragraph and the URL. |

Lessons the page should carry, learned the hard way:

- **A repo mid-release churns.** SWE-chat published v2 in about 15 upload commits over an afternoon. Four plug-ins caught four half-uploaded states and kept a copy of each: 99 GB of old versions for one dataset. The fix is a settle rule: don't start an update until the repo has been quiet for 24 hours.
- **Pausing a download breaks it.** Freezing `hf download` for 25 minutes left a dead connection. Stopping and resuming works; pausing doesn't.
- **Gated repos need two steps.** `hf auth login` on the Mac, then accept each license on the Hub. Some (Meta's) are reviewed by a person, so "requires approval" can last hours.

---

## Part 1: replacement for "Stash a model library on NVMe"

### Stash a model library on NVMe

This section started as a one-pass pull: pick a list, pin it, download it, verify it, done. That worked once. It didn't stay current, and it didn't grow with the projects that use it. The stash now has a small agent that runs every time the drive is plugged in, and a cloud dashboard that shows what it's doing. The rules from the first version still hold: write inside one folder, never erase, pin every download, and check every file.

The original idea came from a 53-second Instagram reel by @reelvisuale pitching a "doomsday pack" of open models saved before access is restricted. The restriction is the author's prediction and this guide doesn't treat it as fact. The useful part is offline continuity.

#### What's on the drive

Read from the catalog on October 4, 2026:

| Folder | Items | Size |
|---|---|---|
| `models/` (MLX, GGUF, full-precision Hugging Face) | 52 | 317 GB |
| `datasets/` | 23 | 54 GB |
| `code/`, `wheels/`, `spaces/`, `papers/`, `runs/`, `corpora/` | 58 | under 5 GB |
| **Total in `stash/`** | | **374 GB of 2 TB** |

The biggest single items are a 75 GB research model that none of the current Macs can run, a 47 GB dataset of coding-agent conversations, a 32 GB coding model and a 30 GB decision model. Most of the drive is still free on purpose.

#### The drive is exFAT, and that's fine for weights

The A1 is formatted exFAT so it reads on any machine. Weights are a few large files, and exFAT handles those well. Three things don't work on exFAT and live on the Mac instead:

- **Python venvs.** exFAT has no symlinks or Unix permissions. Venvs live in `~/.nvme-stash/venvs/`, and the drive keeps the wheels to rebuild them offline.
- **Thousands of small files.** A dataset split into 17,000 JSONL files copies at around 10 MB/s, not 3 GB/s. Budget for it, and prefer Parquet releases when a dataset offers both.
- **macOS metadata.** The Mac writes `._name` files beside everything it touches on exFAT. They're harmless, and the catalog ignores them.

#### What runs on every plug-in

A LaunchAgent on the Mac starts the run when the volume mounts. The run:

1. **Reads the drive.** It builds a catalog of every item: size, files, formats, and which Hub repo and revision it came from.
2. **Checks for updates.** For each pinned item it asks the Hub for the current revision and compares the two file trees. Documentation-only changes are noted and skipped.
3. **Scans for picks.** It matches new Hub models, datasets, Spaces and papers against the topics of your GitHub repos and scores them. Picks wait on the dashboard for you to approve or skip. Like-for-like newer releases of something already stashed (same family, size and quantization) are approved automatically.
4. **Downloads what you approved,** largest-value first, within a per-run cap (60 GB by default) and never below a free-space floor (150 GB). A single item bigger than the cap can go first on a fresh plug-in, so it isn't starved forever.

A heartbeat every minute tells the dashboard whether the drive is plugged in and whether a run is busy. If you're away from the machine, **Run now** on the dashboard starts the same run without re-plugging.

#### Updates keep the old copy

An update never overwrites in place. The new revision downloads to a hidden folder beside the old one (`.name.updating-<sha>`), unchanged large files are copied across instead of re-downloaded, and only when every file checks out does the swap happen. The old copy moves to `stash/versions/<path>@<sha>` and the new one takes the usual path, so scripts and notebooks keep working.

Two rules came from running it:

- **Wait for the repo to settle.** A repo that's mid-release can change a dozen times in an hour. The agent starts an update only after the repo has had no commits for 24 hours (`SETTLE_HOURS` in `scout.env`). An update that's already partly downloaded still finishes.
- **The agent never deletes on the drive.** Old versions pile up. The dashboard's Disk space view lists them with sizes and a copyable delete command you run yourself.

#### Where the pins live

Every download and update appends a record to `manifests/scout-pins.json`: repo, type, revision, path, bytes, and the date. The newest record for a path wins. Each folder also gets a `.verified` file, and a dated `scout-<date>.sha256` file lists a checksum for every file added that day. A pin is still a full 40-character commit, and a pin that no longer resolves is reported, not replaced with the branch tip.

#### Partial repos

Some repos are mostly things you don't want. GPT-2 ships the same weights in six formats; Gemma Scope holds hundreds of sparse autoencoders. A pick can carry an include list (`hf download --include` globs), so the agent downloads one format or one SAE. The size shown on the dashboard is what the download will actually fetch, not the repo's total storage, which counts every revision ever pushed.

#### Gated repos

Some repos ask you to accept a license first. Run `hf auth login` once on the Mac, then accept each license on the repo's Hub page while signed in to the same account. Google's Gemma terms are usually instant. Meta's are reviewed by a person, and the Hub answers "requires approval" until they are. The agent retries on every run.

#### The dashboard

Live progress for a process running on your desk: percentage of the run, GB done of total, average speed in GB/s and MB/s, time left, the current item, what finished, and what's next. It also explains every item on the drive (what it is, why it's there, which of your Macs can run it, and a command to try it), and has a learning path through the whole stash.

#### What this still does not do

It does not speed up generation; memory bandwidth does that, as above. It is not a backup: one drive is one copy, so back up `corpora/` and `manifests/` elsewhere. And it does not decide for you. The agent proposes, you approve, and the only automatic approvals are like-for-like updates of things you already chose.

---

## Part 2: new section, "Look inside the models"

### Look inside the models

Running a model tells you what it says. Interpretability tells you why. The stash now carries a small kit for that, sized to run on a 16 GB M1.

#### Why it needs different copies

The 4-bit MLX models on the drive are right for running. They're wrong for looking inside, because quantization rounds every weight and adds noise to the activations you're trying to read. Interpretability work loads full-precision weights, so the drive keeps a few small models at 16 or 32 bits beside the quantized ones.

| Item | Size | Why |
|---|---|---|
| GPT-2 small | 0.55 GB | The model most published circuits were found in. |
| Pythia-70m and 160m (deduped) | 0.55 GB | Small, with fully open training, for probing and comparing scale. |
| Qwen3-0.6B | 1.5 GB | The full-precision twin of a model already on the drive in 4-bit. |
| GPT-2 small sparse autoencoders | 2.0 GB | One for every layer's residual stream, in SAELens format. |
| Gemma Scope, layer 12, 16k features | 0.3 GB | One slice of Google's SAE set for Gemma 2 2B. The full set is hundreds of GB. |
| Gemma 2 2B | 10.5 GB | The model Gemma Scope was trained on. Gated. |
| Pile-10k | 33 MB | A standard text sample for caching activations and training probes. |

Tools, as offline wheels in `wheels/interp/` with a lock file: PyTorch, TransformerLens 3.x, SAELens, nnsight, Captum and SHAP. Source for the ARENA course, TransformerLens, SAELens and nnsight is in `code/`. TransformerLens is held below 4.0: the 4.0 release reorganized its modules and SAELens doesn't load against it yet.

#### Two tracks

**Explain a prediction.** This is what most explainable-AI work is asked for. Attribution splits one output among its inputs: SHAP for a tabular model, or changing one input at a time for a decision model you can't open. The tabular model, the decision models and the GA4 sample already on the drive are enough to start.

**Open up a network.** This is mechanistic interpretability. In order: read the activations at every layer of GPT-2 and see where the answer appears (the logit lens); train a linear probe on Pythia's activations to predict a property of the input; patch activations between a clean and a corrupted prompt to find the heads an answer depends on; then decompose a layer into features with a sparse autoencoder.

Each step is a section on the A1 Scout learning path, with a figure, a question and a command that runs against the copy on the drive.

#### What this does not do

It doesn't make a 16 GB Mac a research cluster. GPT-2, Pythia and Qwen3-0.6B fit comfortably. Gemma 2 2B at full precision needs about 10 GB plus room for activations, which is tight on 16 GB and comfortable on the 32 GB M6.

#### Sources

- TransformerLens: github.com/TransformerLensOrg/TransformerLens
- SAELens: github.com/jbloomAus/SAELens
- nnsight: github.com/ndif-team/nnsight
- ARENA 3.0: github.com/callummcdougall/ARENA_3.0
- Gemma Scope: huggingface.co/google/gemma-scope-2b-pt-res
- GPT-2 small SAEs: huggingface.co/jbloom/GPT2-Small-SAEs-Reformatted
