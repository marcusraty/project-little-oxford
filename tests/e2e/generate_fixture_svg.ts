import { renderDiagram } from '../../src/diagram/render';
import * as fs from 'node:fs';
import * as path from 'node:path';

const model = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/pin_flow_model.json'), 'utf8'));

async function main() {
  const output = await renderDiagram(model);
  const fixture = {
    svg: output.svg,
    diagram: model,
    diagnostics: output.diagnostics,
  };
  fs.writeFileSync(
    path.join(process.cwd(), 'tests/e2e/fixture_render.json'),
    JSON.stringify(fixture, null, 2),
    'utf8',
  );
  console.log('Generated fixture_render.json');
}

main().catch(console.error);
