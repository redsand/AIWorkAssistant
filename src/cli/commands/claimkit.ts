import { Command } from "commander";
import { claimKitAdapter } from "../../context-engine/adapters/claimkit-adapter";
import { ingestKnowledgeStore, ingestCodebaseStore, ingestGraphStore } from "../../context-engine/claimkit-ingestion";
import { runClaimKitComparison } from "../../eval/comparison/claimkit-comparison";

export function registerClaimKitCommand(program: Command): void {
  const ck = program
    .command("claimkit")
    .description("ClaimKit RAG operations");

  ck
    .command("status")
    .description("Check ClaimKit availability and configuration")
    .action(async () => {
      const available = await claimKitAdapter.initialize();
      if (available) {
        console.log("✅ ClaimKit is available and initialized");
      } else {
        console.log(`❌ ClaimKit is not available: ${claimKitAdapter.getInitError()}`);
      }
    });

  ck
    .command("ingest")
    .description("Ingest all stores (knowledge, graph) into ClaimKit")
    .option("--knowledge", "Ingest knowledge store only")
    .option("--codebase", "Ingest indexed codebase only")
    .option("--graph", "Ingest graph store only")
    .action(async (options) => {
      const all = !options.knowledge && !options.codebase && !options.graph;
      if (all || options.knowledge) {
        const stats = await ingestKnowledgeStore();
        console.log(`Knowledge: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
      }
      if (all || options.codebase) {
        const stats = await ingestCodebaseStore();
        console.log(`Codebase: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
      }
      if (all || options.graph) {
        const stats = await ingestGraphStore();
        console.log(`Graph: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
      }
    });

  ck
    .command("query")
    .description("Query ClaimKit directly")
    .argument("<question>", "Question to ask")
    .action(async (question: string) => {
      const available = await claimKitAdapter.initialize();
      if (!available) {
        console.error("ClaimKit is not available");
        process.exit(1);
      }
      const result = await claimKitAdapter.query(question);
      console.log(`Answerability: ${result.answerability}`);
      console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`Claims: ${result.metadata.claimCount}`);
      console.log(`\nAnswer:\n${result.answer}`);
      if (result.citations.length > 0) {
        console.log(`\nCitations (${result.citations.length}):`);
        for (const cite of result.citations.slice(0, 5)) {
          console.log(`  [${cite.claimId}] ${cite.text.substring(0, 120)}...`);
        }
      }
      if (result.contradictions.length > 0) {
        console.log(`\n⚠️ Contradictions found: ${result.contradictions.length}`);
      }
    });

  ck
    .command("compare")
    .description("Run A/B comparison: ClaimKit vs existing RAG")
    .argument("<queries...>", "Queries to compare")
    .action(async (queries: string[]) => {
      console.log(`Running comparison on ${queries.length} queries...`);
      const result = await runClaimKitComparison({ queries, categories: [] });
      console.log(`\nResults:`);
      console.log(`  ClaimKit wins: ${result.aggregate.wins.claimkit}`);
      console.log(`  RAG wins: ${result.aggregate.wins.rag}`);
      console.log(`  Ties: ${result.aggregate.wins.tie}`);
      console.log(`  ClaimKit avg confidence: ${(result.aggregate.claimkit.mean.confidence * 100).toFixed(1)}%`);
      console.log(`  ClaimKit avg time: ${result.aggregate.claimkit.mean.avgTimeMs.toFixed(0)}ms`);
      console.log(`  RAG avg tokens: ${result.aggregate.rag.mean.avgTokens.toFixed(0)}`);
      console.log(`  RAG avg time: ${result.aggregate.rag.mean.avgTimeMs.toFixed(0)}ms`);
    });
}
