# notes.py <tag> <media>: their notes: words that pop onto the picture outside the caption zone, hold dead still, and go
import sys,json,re,difflib,numpy as np
from events import tracks,STAMP,letters,near
from zone import AXON
def notes(tag,mid,T=18):
    Z=json.load(open(f'{tag}/scan/{mid}.zone.json')); W,H=Z['W'],Z['H']
    z=np.load(f'{tag}/scan/{mid}.thumbs.npz'); th={int(f):t.astype(np.int16) for f,t in zip(z['f'],z['t'])}
    ts=tracks([json.loads(l) for l in open(f'{tag}/scan/{mid}.jsonl')])
    def calm(a,b): return a in th and b in th and float(np.abs(th[a]-th[b]).mean())<=T
    def instamp(b): return any(b[0]>=s[0]-60 and b[2]<=s[2]+60 and b[1]>=s[1]-12 and b[3]<=s[3]+12 for s in Z['stamps'])
    marks=[m for m in json.load(open(f'{tag}/scan/{mid}.marks.json')) if m['kind'] in('label','roamer')]
    def known(t):
        k=re.sub(r'[^a-z0-9]','',t['text'].lower())
        return any(difflib.SequenceMatcher(None,k,w).ratio()>0.6 for w in Z.get('scene',[])+[m['key'] for m in marks])
    out=[]
    for t in ts:
        b=t['box']; cy=(b[1]+b[3])/2/H
        if Z['zone'] and Z['zone'][0]<=cy<=Z['zone'][1]: continue
        if t['n']<3 or t['n']>150 or letters(t['text'])<4 or t['score']<0.85 or STAMP.search(t['text']) or AXON.search(t['text']) or instamp(b) or known(t): continue
        if not t['still']: continue
        pin=t['before'] is not None and calm(t['before'],t['f0']); pout=t['after'] is not None and calm(t['f1'],t['after'])
        if pin or pout: out.append({'f0':t['f0'],'f1':t['f1'],'before':t['before'],'after':t['after'],'box':b,'text':t['text'],'n':t['n'],'in':pin,'out':pout})
    return out
if __name__=='__main__':
    for mid in sys.argv[2:]:
        ns=notes(sys.argv[1],mid); json.dump(ns,open(f'{sys.argv[1]}/scan/{mid}.notes.json','w'))
        print(mid,len(ns),'notes;',sum(n['n'] for n in ns),'reads')
        for n in sorted(ns,key=lambda n:-n['n'])[:14]: print('   ',n['n'],n['f0'],n['box'],repr(n['text'][:44]),'in' if n['in'] else '','out' if n['out'] else '')
