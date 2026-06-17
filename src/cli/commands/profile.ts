import { Command } from "commander";
import { getConfigProfileManager } from "../../config/profile-manager";

/**
 * Register the `profile` subcommands (create / list / switch / delete) on the
 * given program. Extracted from cli.ts so the wiring is unit-testable without
 * importing the CLI entrypoint (which parses argv on load).
 */
export function registerProfileCommands(program: Command): void {
  const profileCmd = program
    .command("profile")
    .description(
      "Manage isolated agent profiles (separate SOUL.md, MEMORY.md, skills)",
    );

  profileCmd
    .command("create <name>")
    .description("Create a new profile")
    .option("--clone <source>", "Clone config and .env from an existing profile")
    .action((name: string, opts: { clone?: string }) => {
      try {
        const pm = getConfigProfileManager();
        const profile = pm.create(
          name,
          opts.clone ? { clone: opts.clone } : undefined,
        );
        console.log(`Created profile '${profile.name}' at ${profile.path}`);
        if (opts.clone) {
          console.log(`  Cloned config and .env from '${opts.clone}'`);
        }
      } catch (err) {
        console.error(
          "Failed to create profile:",
          err instanceof Error ? err.message : err,
        );
        process.exitCode = 1;
      }
    });

  profileCmd
    .command("list")
    .description("List all profiles")
    .action(() => {
      const pm = getConfigProfileManager();
      const active = pm.getActive().name;
      const profiles = pm.list();
      if (profiles.length === 0) {
        console.log("No profiles found");
        return;
      }
      console.log(`Profiles (${profiles.length}):`);
      for (const p of profiles) {
        const marker = p.name === active ? "*" : " ";
        console.log(
          `  ${marker} ${p.name}  (soul: ${p.hasCustomSoul ? "custom" : "default"}, memory: ${p.hasCustomMemory ? "custom" : "default"}, skills: ${p.skillCount})`,
        );
      }
    });

  profileCmd
    .command("switch <name>")
    .description("Switch the active profile")
    .action((name: string) => {
      try {
        const pm = getConfigProfileManager();
        pm.switch(name);
        console.log(`Switched active profile to '${name}'`);
      } catch (err) {
        console.error(
          "Failed to switch profile:",
          err instanceof Error ? err.message : err,
        );
        process.exitCode = 1;
      }
    });

  profileCmd
    .command("delete <name>")
    .description("Delete a profile (cannot delete the active profile)")
    .action((name: string) => {
      try {
        const pm = getConfigProfileManager();
        pm.delete(name);
        console.log(`Deleted profile '${name}'`);
      } catch (err) {
        console.error(
          "Failed to delete profile:",
          err instanceof Error ? err.message : err,
        );
        process.exitCode = 1;
      }
    });
}
