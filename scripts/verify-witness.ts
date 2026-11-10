import { verifyWitnessDir } from '@/lib/witness';

/** npm run verify-witness <path to conversions/<date>-<runId>> */
const dir = process.argv[2];
if (!dir) {
  console.error('usage: npm run verify-witness <conversion directory>');
  process.exit(2);
}
verifyWitnessDir(dir).then(
  (r) => {
    if (r.ok) console.log(`Witness verified: hashes match and the validators reproduce [${r.codes.join(', ') || 'no issue codes'}].`);
    else console.error('Witness verification FAILED:\n' + r.problems.map((p) => '  - ' + p).join('\n'));
    process.exit(r.ok ? 0 : 1);
  },
  (e) => {
    console.error('Could not verify:', e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
