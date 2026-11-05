// Agente falso para testes: ecoa o prompt com o nome do agente.
const prompt = process.argv.at(-1);
process.stdout.write(`FAKE: ${prompt}`);
