import { createProviders } from '@/providers';
import { loadFixtures, runFixture } from '@evals/suite';
(async () => {
  const fx = loadFixtures().find((f) => f.id === process.argv[2])!;
  const r = await runFixture(fx, createProviders(), { keepOutputs: true });
  const main = r.outputs[0].content;
  console.log(process.argv[3] === 'full' ? main : (main.split('\ndef job(')[1] ?? main).split('\ndef close_resources')[0]);
  console.log(r.warningCodes, r.failedChecks);
})();
