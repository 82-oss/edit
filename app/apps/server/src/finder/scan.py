# scan.py <tag> <media> [step]: reads the words on every step-th frame of the media's shown spans -> <tag>/scan/<media>.jsonl
import sys,json,os,cv2,time
from multiprocessing import Pool
tag,mid=sys.argv[1],sys.argv[2]; STEP=int(sys.argv[3]) if len(sys.argv)>3 else 10
PAD=1.0
def merged(sp):
    out=[]
    for a,b in sorted(sp):
        if out and a<=out[-1][1]: out[-1][1]=max(out[-1][1],b)
        else: out.append([a,b])
    return out
def chunks():
    sp=[[max(0,a-PAD),b+PAD] for a,b,*_ in json.load(open(f'{tag}/shown.json'))[mid]]
    out=[]
    for a,b in merged(sp):
        t=a
        while t<b: out.append((t,min(b,t+60))); t+=60
    return out
eng=None
def work(ab):
    cv2.setNumThreads(2)
    global eng
    if eng is None:
        import ocr; eng=ocr.engine(960,True)
    a,b=ab; cap=cv2.VideoCapture(f'{tag}/src/{mid}.mp4'); fps=cap.get(cv2.CAP_PROP_FPS)
    f0=int(round(a*fps)); f0-=f0%STEP; f1=int(b*fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES,f0); out=[]; f=f0
    while f<=f1:
        ok,img=cap.read()
        if not ok: break
        r=eng(img,use_cls=False); lines=[]
        if r.boxes is not None:
            for q,tx,s in zip(r.boxes,r.txts,r.scores):
                x0,y0=q.min(0); x1,y1=q.max(0); lines.append([int(x0),int(y0),int(x1),int(y1),tx,round(float(s),3)])
        out.append({"f":f,"lines":lines})
        for _ in range(STEP-1):
            if not cap.grab(): break
        f+=STEP
    return out
if __name__=='__main__':
    cv2.setNumThreads(1); os.makedirs(f'{tag}/scan',exist_ok=True); t0=time.time(); n=0
    with Pool(int(os.environ.get('PROCS','4'))) as p, open(f'{tag}/scan/{mid}.jsonl','w') as o:
        for res in p.imap(work,chunks()):
            for r in res: o.write(json.dumps(r)+'\n'); n+=1
    print(mid,n,'reads',round(time.time()-t0),'s')
