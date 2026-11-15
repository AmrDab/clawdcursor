/** Terminal questions: a line of text, y/N, and a secret typed as stars. */
import * as readline from 'readline';

export interface Io { input: NodeJS.ReadStream; output: NodeJS.WriteStream }
const STD: Io = { input: process.stdin, output: process.stdout };

export function ask(question: string, io: Io = STD): Promise<string> {
  const rl = readline.createInterface({ input: io.input, output: io.output });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

export async function yesNo(question: string, io: Io = STD): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `, io));
}

/** Read a secret without echoing it: each character shows as *. Enter ends it, Ctrl-C leaves with exit code 130. */
export function askSecret(question: string, io: Io = STD): Promise<string> {
  return new Promise(resolve => {
    const { input, output } = io;
    output.write(question);
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    input.resume();
    let value = '';
    const done = () => { input.removeListener('data', onData); input.setRawMode?.(wasRaw); input.pause(); output.write('\n'); };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { done(); resolve(value); return; }
        if (ch === '\u0003') { done(); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); output.write('\b \b'); } continue; }
        if (ch < ' ') continue;
        value += ch;
        output.write('*');
      }
    };
    input.on('data', onData);
  });
}
