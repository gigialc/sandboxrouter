import { BarNum, Footnote, Num, ResultRow, ResultTable, Toolbar, barMax, money, time } from "@/components/results";
import { site, sizeNote } from "@/lib/site";

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/**
 * One conversation of a chat assistant with a code tool, in one sandbox: first answer, a file up and a file
 * down, short tool calls, and a call after the sandbox sat idle. Fastest first answer first.
 */
export function AssistantTable() {
  const rows = site.assistant;
  if (!rows.length) return null;
  const max = barMax(rows.map((r) => r.firstAnswerMs));
  const dates = [...new Set(rows.map((r) => r.measuredAt.slice(0, 10)))].sort();
  const measured = dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0];
  const { runs, calls, idleSeconds, uploadBytes, downloadBytes } = rows[0];

  return (
    <div>
      <Toolbar note={
        <>
          {rows.length} providers, {runs} sessions each{measured ? `, measured ${measured}` : ""}. Times are what the person waiting sees,
          from the test machine, network included.
        </>
      }>
        {null}
      </Toolbar>
      <ResultTable
        cols={[
          { label: "First answer" },
          { label: "Each tool call" },
          { label: `Upload ${mb(uploadBytes)}`, className: "hidden sm:table-cell" },
          { label: `Download ${mb(downloadBytes)}`, className: "hidden sm:table-cell" },
          { label: "After idle", className: "hidden md:table-cell" },
          { label: "Per session", className: "hidden md:table-cell" },
        ]}
      >
        {rows.map((r, i) => (
          <ResultRow key={r.provider} rank={i + 1} id={r.provider} name={r.name} notes={[sizeNote(r.size), r.filesThroughCommands ? "Files are sent through commands" : ""].filter(Boolean)}>
            <BarNum value={r.firstAnswerMs} max={max} title={`${r.name}: start the sandbox and get the result of a first Python call, median of ${r.runs} sessions`}>
              {time(r.firstAnswerMs)}
            </BarNum>
            <Num title={`Median of ${r.runs * r.calls} short Python calls; the 95th percentile was ${time(r.callP95Ms)}`}>{time(r.callMs)}</Num>
            <Num className="hidden sm:table-cell">{time(r.uploadMs)}</Num>
            <Num className="hidden sm:table-cell">{time(r.downloadMs)}</Num>
            <Num className="hidden md:table-cell" title={`One call after ${r.idleSeconds} seconds with nothing running`}>{time(r.idleMs)}</Num>
            <Num className="hidden md:table-cell" title="Published prices applied to the session's measured time and CPU use">{r.sessionUsd === undefined ? "n/a" : money(r.sessionUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      <Footnote>
        First answer is starting a sandbox plus one Python call: the wait before an assistant has its first result. Each tool call is
        the median of {calls} short Python calls per session, each of which must see what the calls before it wrote. After idle is one
        more call after {idleSeconds} seconds with nothing running. A provider is listed only when every session finished and every
        result checked out.{rows.some((r) => r.filesThroughCommands) && <> Where a row says files are sent through commands, the router has no file endpoint to use on that provider and moves the file in pieces through shell commands, so its upload and download times are for that route.</>} Per session is the published price applied to the measured time and CPU use of one session of about
        {" "}{Math.round((idleSeconds + 30) / 60)} minutes, not an amount from a bill.
      </Footnote>
    </div>
  );
}
