# Public price audit — 2026-11-05

Scope: 31 cloud sandbox providers (Docker excluded), seven computer providers, all routed operating systems, and the eight named shape tables. Public pages and unauthenticated GET requests only. No accounts, trials, forms, purchases, or authenticated operations were used.

USD list rates; default/US region when offered. Promotional credits and negotiated rates do not reduce comparisons. Monthly commitments, included allowances, stopped storage, and time rounding are recorded separately in the JSON. Fixed-size rows select the smallest fitting published shape. Full CPU use is assumed where CPU is metered by activity. Most catalog estimates exclude disk, network and subscription fees; exceptions are explicitly identified.

`catalog` preserves the repository before this audit; `found` is independent evidence. Null means not established, not zero. `ok` means no established discrepancy in the scoped tariff; any unverified limits remain explicit. `changed` includes material note/precision corrections. `conflict` includes contradictory official numbers, ambiguous units, or unverified allocations on which routing depends. Confirmed prices within a conflict are retained, but those entries are not edited. Login-only subfields are identified without treating all public prices as inaccessible.

| Provider | Catalog $/h at 2 vCPU / 4 GB | Found $/h | Status |
|---|---:|---:|---|
| agent37 | $0.0060273973 | $0.0065205479 with default disk | changed |
| agentcore | $0.2168 | $0.2168 | ok |
| alibaba | $0.071424 (router skips: max 2 GB memory) | unavailable (template 2 / 2) | changed |
| azure | $0.03 (router skips: max 1 vCPU) | $0.03/session; size unknown | conflict |
| beam | $0.14 | $0.14 | conflict |
| blaxel | $0.1656 | unresolved | conflict |
| boat | $0.018 | $0.018 | ok |
| cloudflare | $0.216 | $0.216 compute; $0.220032 with disk | changed |
| codesandbox | $0.1486 | $0.1486 | changed |
| daytona | $0.1656 | $0.1656 | conflict |
| dedalus | $0.14904 | $0.14904 | ok |
| deno | $0.3 | $0.30 / $0.164 | conflict |
| e2b | $0.1656 | $0.1656 | conflict |
| exedev | $0.105 | $0.105 | changed |
| freestyle | $0.13362 | $0.133616 | changed |
| hopx | $0.1656 | $0.1656 | conflict |
| instabox | $0.017 | $0.017 | ok |
| koyeb | $0.0576 | $0.0576 | conflict |
| lambda | $0.2522 | $0.25220016 | changed |
| maritime | $0.022 | $0.022 | changed |
| modal | $0.23872 | $0.23796 virtual / $0.379872 adapter | conflict |
| morph | $0.1 | $0.1 | ok |
| northflank | $0.06666 | $0.06666 units / $0.06667 size | conflict |
| novita | $0.11664 | $0.11664 | ok |
| openscale | $0.017 | $0.017 theoretical; base unknown | conflict |
| runloop | $0.3168 | $0.3168 | ok |
| sprites | $0.1645 | $0.1645 | conflict |
| superserve | $0.1656 | $0.1656 | changed |
| tensorlake | $0.2 | $0.2 | ok |
| upstash | $0.2 | $0.2 | conflict |
| vercel | $0.3408 | $0.3408 | changed |

Computer rates use each provider’s actual routed device size, rather than an invented 2 / 4 equivalent. Monthly-only operating systems have no hourly conversion.

| Provider / OS | Catalog $/h | Found $/h | Status |
|---|---:|---:|---|
| aws-workspaces / windows | $0.15 | $0.15 | conflict |
| aws-workspaces / linux | $0.138 | $0.138 JSON / $0.134 example opening | conflict |
| daytona / linux | $0.0666 | $0.0666 | ok |
| e2b / linux | $0.5328 | $0.5328 | ok |
| limrun / android | $3 | $3 paid overage; $3.6 Trial overage | changed |
| limrun / ios | $6 | $6 paid overage; $7.2 Trial overage | changed |
| maritime / linux | $0.12 | $0.12 | changed |
| maritime / windows | $0.18 | $0.18 | changed |
| maritime / android | $0.15 | $0.15 | changed |
| mobilerun / android | $1.8 | $1.8 | ok |
| orgo / linux | $0.055 | $0.055 | ok |
| orgo / windows | monthly plan only | monthly plan only | ok |

## Open questions

1. **Upstash Box — conflict.** The FAQ implies $0.10 per active core-hour, with two busy cores costing $0.20/hour. Both the size table and machine-readable schedule label small/medium/large as $0.10/$0.20/$0.40 **per active CPU-hour**. They do not clearly say those are whole-box hourly totals. Small full-use cost agrees at $0.20/hour; medium/large remain unresolved. Memory is bundled; retained storage is $0.10/GB-month. [source](https://upstash.com/pricing/box); [machine-readable schedule](https://upstash.com/pricing/box.md).

2. **Deno — conflict.** Current Sandbox and Deploy pricing say $0.10/CPU-hour plus $0.025/GiB-hour; the official launch article still says $0.05 plus $0.016/GB-hour. Memory is separately billed under both. At 2 / 4 this is $0.30 versus $0.164/hour. Sandbox needs Pro ($20/month); fixed two CPUs, up to 4 GB, 30-minute sessions. [current Sandbox](https://deno.com/sandbox); [Deploy pricing](https://deno.com/deploy/pricing); [launch article](https://deno.com/blog/introducing-deno-sandbox).

3. **Azure Shell sessions — price confirmed, capacity unresolved.** East US public retail API lists Dynamic Sessions at $0.03 per session-hour; billing documentation rounds allocated built-in sessions to whole hours, and Shell is a built-in session type. No CPU/RAM specification was found for Shell. Catalog 1 / 2 is a placeholder, not a verified allocation. [retail API](https://prices.azure.com/api/retail/prices?%24filter=serviceName+eq+%27Azure+Container+Apps%27+and+armRegionName+eq+%27eastus%27); [billing](https://learn.microsoft.com/en-us/azure/container-apps/billing#dynamic-sessions); [session types](https://learn.microsoft.com/en-us/azure/container-apps/session-pool).

4. **Alibaba international — confirmed.** Default QoS outside mainland China, including Hong Kong: $0.017856/vCPU-hour and $0.008928/GiB-hour. The code-interpreter-v1 template is 2 vCPU / 2048 MB memory / 10240 MB disk. Disk is separately listed at $0.00025308/GiB-hour; no current 15-GiB free threshold is published. Economy and Performance alternatives are retained in JSON. [billing](https://www.alibabacloud.com/help/en/agent-sandbox/product-overview/billing-overview); [template](https://www.alibabacloud.com/help/en/agent-sandbox/user-guide/code-interpreter-v1-template).

5. **Superserve base — resolved by context.** The system template superserve/base is 2 vCPU / 4096 MiB memory / 8192 MiB disk. BuildSpec defaults of 1 vCPU / 1 GiB describe newly built team templates, not that system template. The router’s fixed 2 / 4 rule matches. [system table](https://docs.superserve.ai/templates/overview.md); [BuildSpec defaults](https://docs.superserve.ai/templates/build-spec.md).

6. **Agent37 — conversion documented.** Billing now explicitly divides monthly prices by 730 hours and then 60 minutes; whole-minute billing. Default/gVisor shape prices below include default disk. Imported compute-only rates are valid as compute-only values, but the running shape estimate omitted disk. [billing](https://www.agent37.com/docs/agents-api/billing); [shape table](https://www.agent37.com/docs/agents-api/instance-sizing).

| vCPU / RAM / default disk GB | USD/month | USD/hour | USD/minute |
|---|---:|---:|---:|
| 2 / 4 / 4 | 4.76 | 0.0065205479 | 0.0001086758 |
| 4 / 8 / 6 | 9.34 | 0.0127945205 | 0.0002132420 |
| 4 / 16 / 12 | 15.48 | 0.0212054795 | 0.0003534247 |
| 4 / 32 / 24 | 27.76 | 0.0380273973 | 0.0006337900 |

7. **OpenScale — duration confirmed, base size unresolved.** The public page explicitly has no session time limit; idle boxes auto-pause after five minutes at no cost. It allows 1–8 vCPU and up to 16 GB, in Singapore. The default base template allocation was not found in public docs; no authenticated lookup attempted. [source](https://openscale.so/sandboxes).

8. **Blaxel — public pricing live; API operation unverified.** YC public metadata says acquired. Pricing returned HTTP 200; its status page reports operational. An unauthenticated GET of api.blaxel.ai/v0/sandboxes redirected to login, demonstrating a responding route, not successful sandbox operations. No login or creation was attempted. Public CPU mapping also conflicts with the catalog: 16 GB is six cores, not eight. [YC](https://www.ycombinator.com/companies/blaxel); [pricing](https://blaxel.ai/pricing); [status](https://status.blaxel.ai); [API route](https://api.blaxel.ai/v0/sandboxes); [allocation docs](https://docs.blaxel.ai/Sandboxes/Overview.md).

9. **Koyeb — Standard rates match; plan eligibility conflicts.** The 17 February 2026 acquisition announcement preserves existing plans but restricts new accounts to paid Pro or above. Current Pro is $29/month with $10 compute; all ten Standard instance rates still match the repository. However, its public pricing FAQ says users may downgrade to Starter at any time, without the grandfathering restriction. This eligibility disagreement remains unresolved. This verifies the present table and announcement, not every historical price in between. [announcement](https://www.koyeb.com/blog/koyeb-is-joining-mistral-ai-to-build-the-future-of-ai-infrastructure); [plans](https://www.koyeb.com/pricing); [instances](https://www.koyeb.com/docs/reference/instances); [conflicting FAQ](https://www.koyeb.com/docs/faqs/pricing).

## Changed entries and conflicts

Each evidence line below identifies a public source and the facts it supports. Exact short quotations and check dates are stored once in the companion JSON, alongside complete original catalog values, all fixed shapes, billing details, and unresolved fields. The source changes are restricted to entries marked changed.

### agent37 (sandbox) — changed

Clear conversion is now public. Correct per-resource fields to $0.80/730 and $0.70/730; fixed-size running total includes disk. Default/gVisor rates only; VM compute is 2.5x and Performance compute 4x, excluded from this default comparison.

**Billing:** Whole minutes; monthly rate / 730 / 60. Running bills CPU, RAM and reserved disk; transitions also bill as documented.

**Minimum plan:** No subscription; prepaid wallet. Minimum top-up $5; create requires one day of the selected running rate in balance.

**Paused/stopped:** Sleeping/stopped: $0.09 per reserved GB-month. Cold storage: $0.03 per compressed GB-month.

**Free tier:** One-time $5 after adding an eligible card; not a recurring allowance, excluded from comparison. Three running instances before first top-up.

**Cost rule:** Uses compute-only imported usdHour and omits mandatory default disk. Correct to usdMonth / 730; leave imported compute-only table intact.

- [Evidence](https://www.agent37.com/docs/agents-api/instance-sizing): 2 vCPU / 4 GB, default 4 GB disk, monthly total; 4 / 8, default 6 GB disk, monthly total; 4 / 16, default 12 GB disk, monthly total; 4 / 32, default 24 GB disk, monthly total.
- [Evidence](https://www.agent37.com/docs/agents-api/billing): vCPU-month; RAM GB-month; reserved disk GB-month; documented minute conversion; minimum top-up; cold storage GB-month.

### alibaba (sandbox) — changed

Rates confirmed. Remove unsupported free-disk wording; the current billing table charges active disk and publishes no included threshold. Public template defaults are CPU 2, memory 2048 MB, disk 10240 MB. Public maximum not established; do not substitute default resources for a provider-wide limit.

**Billing:** Per second, one-second minimum; invoices hourly. Active: CPU, RAM and disk.

**Minimum plan:** Pay as you go; no recurring minimum published in billing overview.

**Paused/stopped:** Deep hibernation/snapshots: disk only. Light hibernation: memory plus disk. International disk: $0.00025308/GiB-hour.

**Free tier:** No recurring sandbox allowance established in the billing overview; the catalog claim of 15 GiB free disk is not supported by its current table.

**Cost rule:** Unit arithmetic matches Default QoS; default template is 2 / 2 and therefore cannot fulfil 2 / 4. Catalog limits are template caps, not provider maxima.

- [Evidence](https://www.alibabacloud.com/help/en/agent-sandbox/product-overview/billing-overview): Default international vCPU-second; Default international GiB-second; international disk; Economy CPU; Economy RAM; Performance CPU; Performance RAM.
- [Evidence](https://www.alibabacloud.com/help/en/agent-sandbox/user-guide/code-interpreter-v1-template): template CPU; template memory; template disk.

### azure (sandbox) — conflict

Price is confirmed, capacity is unresolved. Do not treat $0.03/session-hour as $0.03/vCPU-hour, or assert that a session fulfils 2 / 4. Public pricing API returns the meter; Shell tutorial and session-pool documentation do not state its CPU/RAM.

**Billing:** Allocated built-in code-interpreter session duration, rounded in one-hour increments; Shell is listed among built-in interpreter types.

**Minimum plan:** Azure subscription and a session pool; no separate monthly plan established for built-in sessions.

**Paused/stopped:** Still billed while allocated; deallocation ends metering. No distinct Shell pause tariff established.

**Free tier:** No Dynamic Sessions-specific free allowance verified. Container Apps CPU-second grants are not evidence of free sessions.

**Cost rule:** Flat-session rule matches meter. No public Shell CPU/RAM specification established; catalog 1 / 2 is an acknowledged placeholder.

- [Evidence](https://prices.azure.com/api/retail/prices?%24filter=serviceName+eq+%27Azure+Container+Apps%27+and+armRegionName+eq+%27eastus%27): USD/session-hour; meterName Dynamic Sessions, unitOfMeasure 1 Hour.
- [Evidence](https://learn.microsoft.com/en-us/azure/container-apps/billing#dynamic-sessions): allocated session granularity.
- [Evidence](https://learn.microsoft.com/en-us/azure/container-apps/session-pool): supported container types.

### beam (sandbox) — conflict

Conflict/unverified capacity: catalog max 30 CPU derives from concurrent account quota, and max 64 GB was not established as a per-sandbox limit. Preserve entry under conflict rule despite a clear granularity correction.

**Billing:** Sandbox billing is per millisecond, not per second as the catalog note states.

**Minimum plan:** Developer $20/month, including $20 usage. Team $89/month plus usage.

**Paused/stopped:** Compute stops when stopped; storage currently not billed. Planned $0.0001/GB-hour is not a current charge.

**Free tier:** No recurring free sandbox tier established on the pricing page.

**Cost rule:** Performance arithmetic correct; cheaper Shared/Spot tiers require explicit opt-in and are not the default adapter selection.

- [Evidence](https://www.beam.cloud/pricing.md): Performance CPU-hour; Performance GiB-hour; sandboxes; Developer minimum; concurrent account quota; Shared CPU-hour; Shared GiB-hour; Spot CPU-hour; Spot GiB-hour.

### blaxel (sandbox) — conflict

Pricing is live despite YC metadata reporting Acquired. API routing redirects to login; authenticated provisioning untested. Tier maxima are login-only. Memory/CPU mapping conflicts with the catalog; retain it unchanged and do not treat 16 GB as proof of 8 cores.

**Billing:** Active running duration at $0.0000115 per allocated GB RAM-second; CPU bundled and scales with memory.

**Minimum plan:** Pay as you go; no monthly subscription. Higher quota tiers depend on wallet top-ups.

**Paused/stopped:** No compute in standby; memory/filesystem snapshots $0.20/GB-month; images $0.045/GB-month.

**Free tier:** Up to $200 introductory credits, excluded; no recurring allowance established.

**Cost rule:** RAM rate matches, but public docs give 8 GB -> 4 CPU and 16 GB -> 6 CPU, contradicting the formula at the catalog 8-CPU/16-GB cap. A linear 2-GB-per-core assumption is unsafe.

- [Evidence](https://blaxel.ai/pricing): RAM-second compute; snapshot GB-month; image GB-month.
- [Evidence](https://docs.blaxel.ai/Security/Quotas.md): public docs direct tier limits to the authenticated console.
- [Evidence](https://docs.blaxel.ai/Sandboxes/Overview.md): nonlinear mapping.
- [Evidence](https://status.blaxel.ai): public service status.
- [Evidence](https://www.ycombinator.com/companies/blaxel): public ycdc_status metadata.

### cloudflare (sandbox) — changed

Correct the note to state 10 ms metering and separately billed disk/Worker/DO charges. Keep the established compute-only hourlyCost convention; the report supplies the disk-inclusive total explicitly.

**Billing:** 10 ms increments. Active CPU, allocated RAM and allocated disk; default/US schedule.

**Minimum plan:** Workers Paid $5/month; Workers and Durable Objects charges also apply.

**Paused/stopped:** Container resource charges stop on sleep; separate Worker/DO/storage services can still charge.

**Free tier:** No Containers on Workers Free. Paid includes 375 vCPU-min, 25 GiB-h RAM and 200 GB-h disk per month.

**Cost rule:** Compute-only arithmetic and size selection match; disk is extra at $0.000252/GB-hour. Document omitted mandatory disk rather than silently changing the catalog-wide compute comparison convention.

- [Evidence](https://developers.cloudflare.com/containers/platform/pricing/): vCPU-second; GiB-second memory; GB-second disk; billing granularity; Workers Paid minimum; paid CPU allowance; paid RAM allowance; paid disk allowance.

### codesandbox (sandbox) — changed

Together public legacy page lists Pico 2 cores, versus catalog 1. CodeSandbox web documentation returned HTTP 403, not a verified login gate; no second public schedule was retrieved. Update the clear published size correction. This is the deprecated SDK, not Together's successor product.

**Billing:** Credits at $0.01486, rounded up to each started minute.

**Minimum plan:** Build has no subscription fee, with usage credits. Scale $170/month includes 1,100 credits and 250 concurrent VMs.

**Paused/stopped:** Only VM runtime consumes runtime credits. Retained snapshot/storage tariff not established in this page.

**Free tier:** Build allows 10 concurrent VMs; included recurring credit quantity not established in the inspected public source.

**Cost rule:** Nano 2 / 4 remains $0.1486/h. Correct Pico to 2 CPU so a 2 / 1 request selects its published $0.0743/h size.

- [Evidence](https://docs.together.ai/docs/together-code-sandbox-legacy): Pico 2 cores / 1 GB in Together table; Nano 2 / 4; Micro 4 / 8; Small 8 / 16; Medium 16 / 32; Large 32 / 64; XLarge 64 / 128; credit price; Scale monthly minimum; included Scale credits; rounding example for 3m25s; Pico CPU column; Nano also has two cores.

### daytona (sandbox) — conflict

Rates and snapshot sizes match. The limits page inconsistently gives Tier 1 memory as 10 GiB and 20 GiB, and labels org-wide tier resources separately from per-sandbox limits. Catalog 4 / 8 is a public snapshot size, not a verified maximum. Keep entry unchanged.

**Billing:** Per second; CPU and RAM while running; disk separately above the first 5 GiB.

**Minimum plan:** No monthly fee; Tier 2 requires a $25 top-up and linked card.

**Paused/stopped:** Stopped containers retain disk at $0.000108/GiB-hour above 5 GiB; archived container billing stops. VM state rules differ.

**Free tier:** $200 introductory compute credit; excluded. Tier 1 requires email verification.

**Cost rule:** Resource arithmetic correct; disk extra. Public org-tier quotas are not clearly per-sandbox maxima.

- [Evidence](https://www.daytona.io/pricing): CPU; RAM; disk; included disk; introductory credit.
- [Evidence](https://www.daytona.io/docs/en/limits/): Tier 1 resources table; Tier 2 requirement; Tier 1 RAM in later Limits table; conflicts with 10GiB Resources row.
- [Evidence](https://www.daytona.io/docs/en/sandboxes/): 4 CPU / 8 GiB / 10 GiB snapshot.

### deno (sandbox) — conflict

Memory is separately billed under both official schedules. Treat the old launch article versus current price pages as a conflict, as instructed; do not select or rewrite a rate. Public docs cap each session at 30 minutes.

**Billing:** Actual CPU time plus allocated memory time. Deploy describes memory per second; sub-second rounding for Sandbox CPU not stated.

**Minimum plan:** Deploy Pro $20/month; Free does not include Sandbox. Builder $200/month.

**Paused/stopped:** No separate paused tariff established. Persistent volume storage $0.20/GiB-month above plan allowance.

**Free tier:** No Sandbox on Free. Pro includes shared meters: 50 CPU-h, 750 GiB-h memory, 5 GiB volumes; landing launch post still says 40 / 1,000.

**Cost rule:** Fixed two-core rule and 0.75–4 GB range match. Catalog prices match current landing/Deploy pages; official launch article disagrees.

- [Evidence](https://deno.com/sandbox): current sandbox CPU; current sandbox memory.
- [Evidence](https://deno.com/blog/introducing-deno-sandbox): launch CPU; launch memory.
- [Evidence](https://deno.com/deploy/pricing): Pro subscription; Pro shared CPU allowance; Pro shared RAM allowance; volume overage.
- [Evidence](https://docs.deno.com/sandbox/): fixed CPU; memory range; maximum minutes.

### e2b (sandbox) — conflict

Public numerical rates and standard sizes match. Pricing card says Hobby has default resources, but detailed pricing and billing docs permit up to 8 / 8; record that wording ambiguity without changing the confirmed shared maximum.

**Billing:** Per second while running.

**Minimum plan:** Hobby $0/month plus usage; Pro $150/month plus usage, no additional included usage credit.

**Paused/stopped:** Compute billing stops on pause; unlimited retention documented. No separate paused-storage rate established in inspected pricing/billing pages.

**Free tier:** Hobby $100 one-time credit; 20 concurrent, one-hour continuous sessions, 10 GiB disk. No recurring compute grant.

**Cost rule:** Per-resource arithmetic correct; source unit prices multiplied by 3,600.

- [Evidence](https://e2b.dev/pricing): 1 vCPU-second; 1 GiB-second; Pro monthly subscription; one-time credit.
- [Evidence](https://docs.e2b.dev/billing): Pro memory ceiling is extensible by request; Hobby base fee; paused retention.

### exedev (sandbox) — changed

Update public self-serve maximum to 32 / 64, and state subscription requirements. The separate marketing usage option at $0.05/core-hour + $0.016/GiB-hour requires contacting the provider and is not the standalone reserved-capacity API tariff audited here.

**Billing:** Reserved standalone capacity per second; no time minimum, invoice rounded to cents.

**Minimum plan:** Personal starts $15/month for 2 vCPU / 4 GiB pool; standalone usage is additional. Work regular $75/month (introductory discount excluded).

**Paused/stopped:** Stopped standalone CPU/RAM unbilled; retained disk remains subject to plan allowances/usage. Disk overage rate not established here.

**Free tier:** No recurring free standalone tier established.

**Cost rule:** 2-GiB-per-vCPU rounding matches; Work permits up to 32 vCPU without approval, above catalog 16 / 32.

- [Evidence](https://exe.dev/docs/standalone-vms.md): 2 vCPU / 4 GiB unit-hour; Work self-serve ceiling; memory constraint.
- [Evidence](https://exe.dev/pricing): Personal minimum; regular Work fee.

### freestyle (sandbox) — changed

Clarify that disk is separately priced but included in the fixed-size estimate, and add the required paid-plan minimum. Imported shape arithmetic is correct to its declared rounding; no imported file changes.

**Billing:** Allocated CPU, memory and disk, metered per second. Published hourly disk rate $0.000086/GiB-hour.

**Minimum plan:** Free available; Hobby $50/month minimum includes $50 usage; Pro $500/month includes $500.

**Paused/stopped:** Storage only at $0.000086/GiB-hour after included allowance.

**Free tier:** Monthly 200 vCPU-h, 400 GiB-h RAM, 60,000 GiB-h storage; 10 VMs, max 4 / 8. Applies to every plan; Free stops at allowances.

**Cost rule:** Includes disk correctly; rounds each fixed shape to five decimals. Exact 2 / 4 / 16 total is $0.133616 versus stored $0.13362.

- [Evidence](https://www.freestyle.sh/docs/vms/pricing-and-limits): vCPU-hour; GiB-hour; disk GiB-hour; Hobby minimum; Pro minimum; CPU free allowance; RAM free allowance; disk free allowance.
- [Evidence](https://www.freestyle.sh/docs/vms/base-snapshots): 32 / 64 / 128 shape; max published Pro shape.

### hopx (sandbox) — conflict

Catalog limits are an assumed default template size. Public configuration docs allow CPU 1–64 and RAM 512 MB–64 GB depending on plan, without establishing the default template or cheapest-plan ceiling. Leave unresolved values unchanged.

**Billing:** Per second; CPU/RAM plus storage $0.000108/GiB-hour.

**Minimum plan:** No subscription or minimum commitment.

**Paused/stopped:** Pricing says no idle charges; whether retained storage remains billed is not explicit.

**Free tier:** $200 introductory credits; excluded. No recurring allowance established.

**Cost rule:** Arithmetic matches rates, but code-interpreter template 2 / 4 allocation is not publicly confirmed.

- [Evidence](https://hopx.ai/pricing): CPU; GiB RAM; GiB disk; plan/idle claims.

### koyeb (sandbox) — conflict

All ten Standard instance rates match. Acquisition announcement restricts new users to paid plans and grandfathers existing Starter, but current pricing FAQ says users can downgrade to Starter at any time without that restriction. Record the plan-eligibility conflict; instance rate comparison itself is unchanged.

**Billing:** Per second. Standard instance price includes its paired CPU/RAM allocation.

**Minimum plan:** Announcement and current pricing: new accounts Pro $29/month with $10 compute, or Scale $299 with $100. Pricing FAQ also says any user can downgrade to Starter; eligibility conflict.

**Paused/stopped:** Pricing FAQ: only unpaused Services are billed. Subscription fee remains; no separate sandbox snapshot/storage tariff established.

**Free tier:** FAQ publishes a free web Service 0.1 CPU/512 MB/2 GB disk and free PostgreSQL, not free sandbox compute. New-account Starter eligibility conflicts with acquisition announcement.

**Cost rule:** Correct: 2 / 4 request selects large 4 / 4 at $0.0576/h; nominal per-vCPU field alone does not price RAM-heavy sizes.

- [Evidence](https://www.koyeb.com/docs/reference/instances): Standard nano hourly USD; Standard micro hourly USD; Standard small hourly USD; Standard medium hourly USD; Standard large hourly USD; Standard xlarge hourly USD; Standard 2xlarge hourly USD; Standard 3xlarge hourly USD; Standard 4xlarge hourly USD; Standard 5xlarge hourly USD.
- [Evidence](https://www.koyeb.com/pricing): Pro; Pro credit; Scale.
- [Evidence](https://www.koyeb.com/blog/koyeb-is-joining-mistral-ai-to-build-the-future-of-ai-infrastructure): grandfathering discussed in acquisition FAQ.
- [Evidence](https://www.koyeb.com/docs/faqs/pricing): stopped compute; plan size availability; conflicts with acquisition announcement new-account restriction.

### lambda (sandbox) — changed

The catalog rounded CPU and RAM rates. Replace with exact public per-second conversions ($0.09969984/vCPU-h and $0.01320012/GB-h). Source SKUs 6U84GHCW7DVGDQV9 and 7KTPAUAWTZHSC66Z. Snapshot charges excluded from running compute comparison.

**Billing:** Baseline reservation while running plus actual bursts, measured per second; 2 GB per vCPU; bursts up to 4x within the 4-vCPU/8-GB ceiling.

**Minimum plan:** Usage pricing; no monthly subscription.

**Paused/stopped:** No compute while suspended (up to 8 h). Snapshot storage $0.0001111111/GB-hour, reads $0.0015467699/GB, writes $0.0037977138/GB. Image retention minimum one week.

**Free tier:** No MicroVM-specific recurring allowance established; do not apply ordinary Lambda request/GB-second free grants.

**Cost rule:** Size rounding and 2:1 memory/CPU rule match; retain precision from the public per-second price list.

- [Evidence](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json): ARM vCPU-second USD; ARM GB-second USD; snapshot GB-hour USD; snapshot read GB USD; snapshot write GB USD.
- [Evidence](https://aws.amazon.com/lambda/pricing/): maximum; granularity; image storage.

### maritime (sandbox) — changed

Add required monthly plan and paused storage to the note; rates and limits unchanged.

**Billing:** Per second, no minimum; running ephemeral disk included.

**Minimum plan:** Starter $20/month includes $20 usage; Growth $100 and Scale $500 each include their fee in usage.

**Paused/stopped:** If configured to pause, $0.08/GB-month disk. Default idle action ends sandbox and deletes disk.

**Free tier:** Seven-day trial up to $20 usage, card required; excluded. No recurring free plan published.

**Cost rule:** Resource rates and max size match; plan minimum and paused disk missing from catalog note.

- [Evidence](https://maritime.sh/pricing): CPU-hour; GB-hour; Starter subscription; disk GB-month; sandbox maximum.

### modal (sandbox) — conflict

Do not apply a rate-only fix: CPU unit mapping must be resolved in the adapter, outside requested source-file scope. Catalog RAM .0242 differs from printed .00000667/second × 3600 = .024012. Public sandbox rate .00003942/physical-core-second ×3600=.141912; normalized 2 vCPU/4 GiB=.23796, current adapter 2 physical cores/4 GiB=.379872. Region pinning adds 1.15–1.75x. Catalog 64/256 maximum not verified.

**Billing:** Per second; max(request, actual use) for CPU and RAM. API cpu is physical cores, each equivalent to two vCPUs.

**Minimum plan:** Starter $0/month plus usage with $30 recurring credits; Team $250/month with $100 credits.

**Paused/stopped:** No generic paused tariff established. Volumes $0.09/GiB-month after first 1 TiB; snapshot-specific tariff not established.

**Free tier:** Starter $30/month credit; credits are not lower unit prices.

**Cost rule:** src/providers/modal.ts passes requested vcpu as physical cpu without dividing by two. Catalog normalizes CPU to virtual cores, so it understates actual adapter reservation. Printed sandbox rates also differ slightly from literal 3x standard rates.

- [Evidence](https://modal.com/pricing): physical CPU-core-second; RAM GiB-second; sandbox premium; Starter recurring credit; Team fee; Team credit.
- [Evidence](https://modal.com/docs/guide/sandbox-resources): API unit conversion.

### northflank (sandbox) — conflict

Public calculator offers up to 32/488, adapter PLANS up to 32/128, and catalog caps at 8/16. These are distinct limits; the catalog cap is more restrictive than either public sizes or adapter selection. Unit and bundled prices disagree at rounding precision; retain both rather than guessing the authoritative invoice basis.

**Billing:** Configured CPU/RAM per second. Persistent SSD $0.11657/GiB-month and egress $0.06/GB separate.

**Minimum plan:** Free Sandbox plan available; pay as you go has no seat fee or mandatory subscription published.

**Paused/stopped:** Adapter has no pause. Persistent storage retains its own billing; no separate stopped ephemeral tariff established.

**Free tier:** Up to $20/month resources across two services, two jobs and one database.

**Cost rule:** Catalog uses continuous unit arithmetic although provider uses discrete compute plans; actual adapter selects a fitting PLANS entry. At 2/4, published shape price differs by $0.00001/hour, plausibly rounding but not silently resolved.

- [Evidence](https://northflank.com/pricing): vCPU-hour; GB-hour; nf-compute-200 hourly; largest public selector size; GiB-month storage; free resource ceiling.

### openscale (sandbox) — conflict

Default base CPU/RAM remains unresolved. Public site answers the duration question explicitly. Do not turn the requested 2 / 4 into an asserted template size; no authenticated template lookup attempted.

**Billing:** Allocated CPU/RAM per second; 25 GB disk included.

**Minimum plan:** No platform fee or minimum.

**Paused/stopped:** Free; automatic pause after 5 idle minutes preserves memory/files.

**Free tier:** $5 introductory credit advertised, excluded. No recurring allowance established.

**Cost rule:** Linear rates verified, but adapter uses base template whose allocation is not publicly established.

- [Evidence](https://openscale.so/sandboxes): vCPU-hour; GiB-hour; CPU range; RAM maximum; duration; pause.

### sprites (sandbox) — conflict

Rate confirmed; catalog cap is explicitly based on reports rather than a published per-Sprite limit. Treat capacity as unresolved, preserve entry. Persistent filesystem is 100 GB, billed on used storage, not allocated capacity.

**Billing:** Actual cumulative CPU and actual RAM usage; public page describes hourly metering, without specifying smaller rounding granularity.

**Minimum plan:** Pay as you go; optional plans, no required subscription published.

**Paused/stopped:** Warm/cold compute unbilled. Cold storage $0.000027/GB-hour; hot storage $0.000683/GB-hour while awake.

**Free tier:** Introductory $1/$30 credits and invoices under $5 waived as described publicly; excluded from list-rate comparison.

**Cost rule:** Arithmetic correct for 2 CPU-hours and 4 RAM GB-hours consumed, not a reservation. Public fixed capacity of 8 / 8 not established.

- [Evidence](https://fly.io/sprites): CPU; RAM; hot disk; cold disk.
- [Evidence](https://docs.sprites.dev/working-with-sprites/): filesystem capacity.

### superserve (sandbox) — changed

Resolve the apparent 1/1 versus 2/4 conflict by scope: BuildSpec defaults for newly built templates are 1/1; system templates including superserve/base are 2/4. Update minimum-plan and storage notes, remove uncorroborated recurring allowance.

**Billing:** Allocated CPU and RAM per second while active; retained storage $0.000108/GiB-hour.

**Minimum plan:** Developer $20/month includes $20 usage; Pro $250 includes $250. Resource docs also name a Free plan, but current pricing does not quantify its recurring allowance or eligibility.

**Paused/stopped:** Retained storage only: shared template once, plus per-sandbox changed blocks; do not multiply full template disk by sandbox count.

**Free tier:** Pricing says start free but provides no recurring free quota. Older catalog $0.13/day cannot be confirmed from current pricing; omit that claim.

**Cost rule:** Fixed 2 / 4 rule matches system template. Catalog 2/4 limit deliberately matches default, not custom-template maximum.

- [Evidence](https://superserve.ai/pricing): vCPU-hour; GiB-hour; retained storage GiB-hour; Developer monthly; Pro monthly.
- [Evidence](https://docs.superserve.ai/templates/overview.md): system-template CPU / RAM / disk.
- [Evidence](https://docs.superserve.ai/templates/build-spec.md): new BuildSpec defaults, separate context.

### upstash (sandbox) — conflict

Explicit conflict: FAQ uses core-hours and $0.20 for two fully active cores; size table and machine-readable schedule say $0.10/$0.20/$0.40 per active CPU hour by size. Do not reinterpret those as box-hour prices. Preserve catalog until clarified.

**Billing:** Actual active core-hours; no CPU charge while idle. Exact sub-hour billing rounding not published.

**Minimum plan:** Pay as you go, no monthly fee. Keep-alive is a separate fixed $8/$16/$32 monthly tariff.

**Paused/stopped:** No active CPU; retained disk/snapshots $0.10/GB-month on PAYG. Keep-alive includes CPU/storage.

**Free tier:** 5 CPU-hours/month, 10 concurrent boxes.

**Cost rule:** Small 2/4 full-use $0.20/h agrees under both per-core interpretations. Medium/large costs are unresolved. No source clearly labels .10/.20/.40 as whole-box hourly totals.

- [Evidence](https://upstash.com/pricing/box.md): Small; Medium; Large; FAQ two-core example.
- [Evidence](https://upstash.com/pricing/box): storage; free CPU; small keep-alive.

### vercel (sandbox) — changed

Add minimum one-minute memory billing, region, Hobby/Pro plan basis and retained snapshot cost to note; no rate or ceiling change.

**Billing:** Actual cumulative CPU time; allocated RAM billed in minimum one-minute increments; $0.60 per million creations.

**Minimum plan:** Hobby free within hard quotas. Pro starts $20/month with $20 usage credit shared across Vercel.

**Paused/stopped:** Snapshots $0.08/GB-month; optional drives $0.05/GB-month in iad1, reads/writes separate. No running CPU/RAM once stopped.

**Free tier:** Monthly 5 CPU-hours, 420 GB-hours RAM, 5,000 creations, 20 GB transfer. Snapshot/drive storage 15 GB lifetime allowance each.

**Cost rule:** Full-use CPU/RAM arithmetic and 2 GB/vCPU pairing match. Additional creation/storage/network charges excluded.

- [Evidence](https://vercel.com/docs/vercel-sandbox/pricing): CPU; RAM; RAM billing; creations; snapshots; Pro credit; free CPU; free RAM.

### aws-workspaces (computer) — conflict

Public AWS JSON lists Rocky stream.standard.medium fleet .088/h and Windows .10/h; add .05 MCP fee. Pricing page introduces Rocky example at .084/h but its calculation uses .088/h, an internal conflict. Preserve existing entry. Chosen size 2/4 is not provider maximum. JSON SKUs E9H27G48B7D7E9ME (Rocky), YRQ27XGJJA8K8EM2 (Windows).

**Billing:** Windows fleet rounded up to hours; Linux fleet per second, 15-minute minimum. Agent MCP $0.05/hour metered per second in addition.

**Minimum plan:** No monthly subscription; requires a provisioned fleet. Windows additionally $6.42 per AI-agent user/month.

**Paused/stopped:** On-Demand stopped fleet $0.025/hour; Always-On fleet billed fully even without a session. Deleting MCP session does not terminate fleet billing.

**Free tier:** First 10 MCP session-hours per region/month free; fleet and licences remain separately billable.

- [Evidence](https://aws.amazon.com/workspaces/applications/pricing/): Rocky example opening; same example calculation; MCP session-hour; Windows agent licence/month; stopped instance-hour.
- [Evidence](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonAppStream/current/us-east-1/index.json): Rocky fleet SKU price; Windows fleet SKU price.

### limrun (computer) — changed

Existing hourly values match paid overage. Clarify that no-fee Trial overage has a different unit price, and that $0.04/credit examples allocate the monthly allowance rather than state marginal overage. No public emulator CPU/RAM maximum established.

**Billing:** Android emulator 1 credit/minute; iOS simulator 2 credits/minute. Paid overage $0.05/credit. Exact partial-minute rounding not stated.

**Minimum plan:** Entry $20/month includes 500 credits; Individual $200 includes 5,000. Optional Trial overage requires no monthly subscription but costs $0.06/credit.

**Paused/stopped:** No device pause in routed SDK; idle emulator is deleted at inactivity timeout. Build-instance warm rates are a separate product.

**Free tier:** Trial 120 one-time credits; excluded. Not renewed by optional overage.

- [Evidence](https://limrun.com/pricing): paid rate; optional Trial rate; Entry; Individual; one-time Trial credits; Entry allowance.

### maritime (computer) — changed

All OS hourly prices match. Add explicit monthly plan minimums to note. Linux 2/4 allocation is explicit; Windows/Android share catalog size but separate public hardware specifications were not established.

**Billing:** Per second while awake, no hourly minimum.

**Minimum plan:** Starter $20/month includes $20 usage. Windows requires Growth $100/month including $100 usage.

**Paused/stopped:** $0.08/GB-month retained disk, metered per second asleep.

**Free tier:** Seven-day trial, up to $20 usage, excluded; no recurring free tier.

- [Evidence](https://maritime.sh/pricing): Linux hourly; Windows hourly; Android hourly; Growth monthly.

## Coverage and limitations

38 entries: 12 ok, 12 changed, 14 conflict. All providers yielded at least a public pricing source; no whole entry was classified login-only or unreachable. Blaxel quota details are login-only. CodeSandbox direct docs returned 403, with public Together legacy documentation used instead.

Maxima retain their scope: provider maximum, subscription ceiling, adapter-supported size, and fixed template allocation are not interchangeable. Unknown cheapest-plan maxima remain null. Computation estimates are not measured invoices or proof of API availability.

All eight requested tables were compared: AGENT37_SHAPES, INSTABOX_SIZES, KOYEB_INSTANCES, FREESTYLE_SIZES, BOAT_SIZES, CLOUDFLARE_INSTANCES, CODESANDBOX_TIERS, UPSTASH_SIZES. The only direct shape correction is CodeSandbox Pico CPU; Agent37 running-cost conversion changes within catalog.ts. No provider adapter or imported table file is changed.

## Validation and review handoff

- `npm run typecheck && npm test`: typechecking passed. The restricted test run could not bind local mock-server sockets; rerunning `npm test` with localhost access produced **278 passed, 1 failed** across 29 files. The sole failure is `test/codesandbox.test.ts:113`, which still expects a 2 CPU / 1 GB request to select Nano. Its later uniform per-core-rate assertion also assumes Pico has one CPU. Both assumptions are contradicted by the public Together size table. Tests remain unchanged under the confirmed two-source-file scope; permission to update this existing test was requested separately.
- Independent read-only checks passed: 38 unique provider/kind records; every frozen catalog value preserved; exactly 12 changed entries modified, all with today's check date; all short evidence quotes matched retrieved source text; corrected Agent37 totals and CodeSandbox tier boundaries verified.
- `node --import tsx scripts/readme-tables.ts`: succeeded; its complete Prices and Env tables replaced the corresponding README tables.
- `npm run site:data`: succeeded; generated 32 catalog entries including Docker, seven computer providers, zero benchmark reports. The audit array is correctly ignored by the benchmark report loader.
- `npm run price:check -- --update`: ran and refreshed the baseline; exit 1 because the Northflank page's extracted dollar amounts changed. Alibaba and Azure require manual review because their pages contain no dollar-sign amounts recognised by the checker. Their public billing table and retail JSON, respectively, were checked in this audit. The checker detects page changes, not authoritative invoice prices.
- `git diff --check`: passed. Only the two authorised source files, the two audit reports, README tables, generated site data, and price-watch baseline are included. No provider adapter, imported shape file, dependency, or test is changed. No push or merge.
